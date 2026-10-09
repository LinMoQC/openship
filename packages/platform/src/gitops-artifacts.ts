import type { Deployment, Service, ServiceDeployment } from "@repo/db";
import { releaseHash } from "./releases";

export type ArtifactDeployment = Pick<Deployment, "id" | "projectId" | "organizationId" | "environment" | "status" | "commitSha" | "createdAt" | "meta">;
export type ArtifactService = Pick<Service, "id" | "projectId" | "name" | "advanced">;
export type ArtifactRow = Pick<ServiceDeployment, "deploymentId" | "serviceId" | "serviceName" | "containerId" | "imageRef" | "status" | "createdAt">;
export type ReleaseServiceArtifact = ArtifactRow & { sourceDeploymentId?: string };
export interface ReleaseArtifactReader {
  listByService(id: string): Promise<ArtifactRow[]>;
  deployment(id: string): Promise<ArtifactDeployment | undefined>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Deployment snapshot is unavailable");
  return value as Record<string, unknown>;
}
function snapshot(deployment: ArtifactDeployment) {
  const meta = record(deployment.meta);
  if (meta.runtimeMode !== "docker" || !Array.isArray(meta.composeServices) || meta.composeServices.length > 200) throw new Error("Docker Compose snapshot is unavailable");
  return meta;
}
function taskSpec(deployment: ArtifactDeployment, name: string) {
  const services = snapshot(deployment).composeServices as unknown[];
  const matches = services.map(record).filter(service => service.name === name);
  if (matches.length !== 1) throw new Error("Task snapshot is ambiguous or missing");
  return matches[0]!;
}
function executionAdvanced(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? null;
  const advanced = { ...value as Record<string, unknown> };
  // Newer Compose parsers record an empty template-key list even when no
  // environment substitution is configured. It adds no execution semantics.
  // Preserve nonempty and malformed markers so real provenance changes fail.
  if (Array.isArray(advanced.environmentTemplateKeys) && advanced.environmentTemplateKeys.length === 0) delete advanced.environmentTemplateKeys;
  return advanced;
}
function taskTree(spec: (name: string) => Record<string, unknown>, name: string) {
  const visited = new Set<string>(), tree: Record<string, unknown> = {};
  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    const definition = spec(name);
    // Runtime-affecting fields only; mutable UI flags (everDeployed, routing)
    // cannot stand in for the execution captured by this deployment.
    tree[name] = Object.fromEntries(["kind", "image", "build", "dockerfile", "buildArgs", "ports", "volumes", "command", "commandArgv", "environment", "dependsOn", "restart", "advanced"].map(key => [key, key === "advanced" ? executionAdvanced(definition[key]) : definition[key] ?? null]));
    if (!Array.isArray(definition.dependsOn) || definition.dependsOn.some(dep => typeof dep !== "string")) throw new Error("Task dependency snapshot is unknown");
    for (const dependency of definition.dependsOn) visit(dependency);
  }
  visit(name);
  return tree;
}
function taskTreeHash(deployment: ArtifactDeployment, name: string) {
  const meta = snapshot(deployment);
  return releaseHash({ tree: taskTree(task => taskSpec(deployment, task), name), host: Object.fromEntries(["runtimeMode", "serverId", "hasServer"].map(key => [key, meta[key] ?? null])) });
}
/** The same execution tree from plain Compose definitions, so two revisions compare before any deploy. */
export function composeTaskTreeHash(services: ReadonlyArray<Record<string, unknown>>, name: string) {
  return releaseHash(taskTree(task => {
    const matches = services.filter(service => service.name === task);
    if (matches.length !== 1) throw new Error("Task definition is ambiguous or missing");
    return matches[0]!;
  }, name));
}
/**
 * Completion tasks a scoped release leaves untouched must still be proven at
 * acceptance by a past success with the same execution tree. When the target
 * moves that tree, acceptance can only fail — after containers were replaced —
 * so name them before anything deploys. Unknown definitions count as drift.
 */
export function untouchedTaskDrift(input: { tasks: string[]; selected: string[]; incumbent: ReadonlyArray<Record<string, unknown>>; target: ReadonlyArray<Record<string, unknown>> }): string[] {
  return input.tasks.filter(name => !input.selected.includes(name)).filter(name => {
    try { return composeTaskTreeHash(input.incumbent, name) !== composeTaskTreeHash(input.target, name); }
    catch { return true; }
  }).sort();
}
function deliberatelyExcluded(deployment: ArtifactDeployment, serviceId: string) {
  const ids = snapshot(deployment).targetServiceIds;
  return Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === "string") && !ids.includes(serviceId);
}
function sameScope(current: ArtifactDeployment, source: ArtifactDeployment) {
  return source.projectId === current.projectId && source.organizationId === current.organizationId && source.environment === current.environment && /^[a-f0-9]{40}$/.test(source.commitSha ?? "") && source.createdAt <= current.createdAt;
}

/** A scoped Compose deploy deliberately leaves completion jobs untouched. Read
 * their original successful record; never relabel, recreate or write history. */
export async function resolveReleaseServiceArtifacts(deployment: ArtifactDeployment, services: ArtifactService[], rows: ArtifactRow[], names: string[], reader: ReleaseArtifactReader): Promise<ReleaseServiceArtifact[]> {
  const resolved: ReleaseServiceArtifact[] = [...rows];
  for (const name of names) {
    const service = services.find(s => s.name === name);
    const row = resolved.find(r => r.serviceId === service?.id);
    if (!service?.advanced?.runToCompletion || row?.containerId) continue;
    if (service.projectId !== deployment.projectId || row?.deploymentId !== deployment.id || row.status !== "skipped" || !deliberatelyExcluded(deployment, service.id)) throw new Error("Task was not deliberately left completed");
    const spec = taskSpec(deployment, name), hash = taskTreeHash(deployment, name);
    if (record(spec.advanced).runToCompletion !== true || typeof spec.image !== "string" || !/@sha256:[a-f0-9]{64}$/.test(spec.image)) throw new Error("Task has no immutable execution snapshot");
    const history = (await reader.listByService(service.id)).filter(r => r.deploymentId !== deployment.id && r.createdAt <= deployment.createdAt).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    let original: ArtifactRow | undefined;
    for (const prior of history) {
      const source = await reader.deployment(prior.deploymentId);
      if (!source || !sameScope(deployment, source) || prior.serviceId !== service.id || prior.serviceName !== name || taskTreeHash(source, name) !== hash) throw new Error("Task source scope or execution snapshot changed");
      // An unrelated service can fail without having attempted this explicitly
      // excluded job. Only its skipped row is transparent; a job failure is not.
      if (prior.status === "skipped" && !prior.containerId && ["ready", "failed", "cancelled"].includes(source.status) && deliberatelyExcluded(source, service.id)) continue;
      if (source.status !== "ready" || prior.status !== "success" || !prior.containerId || prior.imageRef !== spec.image) throw new Error("Most recent task attempt is not a proven success");
      original = prior;
      break;
    }
    if (!original) throw new Error("Completed task container provenance is unknown");
    resolved[resolved.indexOf(row)] = { ...original, sourceDeploymentId: original.deploymentId };
  }
  return resolved;
}

/**
 * Observation must survive one unprovable task: resolve each service alone and
 * name the ones whose completion cannot be proven, so an inspection can still
 * describe the runtime and plan a recovery instead of failing as a whole.
 * Acceptance keeps the all-or-nothing resolveReleaseServiceArtifacts.
 */
export async function resolveObservedServiceArtifacts(deployment: ArtifactDeployment, services: ArtifactService[], rows: ArtifactRow[], names: string[], reader: ReleaseArtifactReader) {
  let resolved: ReleaseServiceArtifact[] = rows;
  const unproven: string[] = [];
  for (const name of names) {
    try { resolved = await resolveReleaseServiceArtifacts(deployment, services, resolved, [name], reader); }
    catch { unproven.push(name); }
  }
  return { rows: resolved, unproven };
}

export function assertRetainedTaskContainer(deployment: ArtifactDeployment, name: string, artifact: ReleaseServiceArtifact, actual: {
  deploymentId: string | null; serviceName: string | null; projectId: string | null; running: boolean; exitCode: number; command: string[] | null; entrypoint: string | string[] | null;
}) {
  if (!artifact.sourceDeploymentId) return;
  const spec = taskSpec(deployment, name), advanced = record(spec.advanced);
  if (actual.projectId !== deployment.projectId || actual.serviceName !== name || actual.deploymentId !== artifact.sourceDeploymentId || actual.running || actual.exitCode !== 0 || !Array.isArray(spec.commandArgv) || releaseHash(actual.command) !== releaseHash(spec.commandArgv) || releaseHash(actual.entrypoint) !== releaseHash(advanced.entrypoint ?? null)) throw new Error("Retained task runtime does not match its successful source");
}
