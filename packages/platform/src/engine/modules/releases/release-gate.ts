import YAML from "yaml";
import { AppError } from "@repo/core";
import { repos, toComposeSpec, composeWritePatch, composeSpecsEqual } from "@repo/db";
import { createGitopsGate, requireUnmanagedProject, type GitopsCommand } from "../../../gitops-gate";
import { manifestHash, releaseHash } from "../../../releases";
import { gitopsConfigurationHash, renderGitopsCompose, type GitopsComposeContract } from "../../../gitops-compose";
import { releaseStore } from "./release-store";
import { githubFile, releaseWorkflow } from "./release-github";
import { parseComposeFile } from "../../lib/compose-parser";
import { decrypt } from "../../lib/encryption";
import type { ExecutionContext } from "../../../context";
import { assertDeploymentsAvailable } from "../../../deployment-maintenance";
import { assertReleaseHostConfiguration } from "./release-topology";
import { resolveDeploymentRuntimeForRead, disposeRuntime } from "../../lib/deployment-runtime";
import { DockerRuntime } from "@repo/adapters";
import { inspectMigrationExecution } from "./release-migrations";
import { migrationExecutionMatches } from "../../../gitops-migrations";

export const requireGitopsRelease = (id: string) => requireUnmanagedProject(id, releaseStore.binding);
export async function serverEnvironmentHash(projectId: string, environment: string) {
  const rows = await repos.project.listEnvVars(projectId, environment);
  // Hash encrypted storage, not plaintext values. This opaque stamp invalidates
  // a frozen plan when project or per-service environment configuration changes.
  return releaseHash(rows.map(row => ({ key: row.key, serviceId: row.serviceId, value: row.value })).sort((a,b) => `${a.serviceId ?? ""}:${a.key}`.localeCompare(`${b.serviceId ?? ""}:${b.key}`)));
}
export async function requireEditableReleaseConfiguration(projectId: string) {
  if (!await releaseStore.binding(projectId)) return;
  if (await releaseStore.active(projectId) || (await repos.releases.journals(projectId)).some(row => !["committed", "restored"].includes(row.stage)))
    throw new AppError("Environment changes are blocked during release or unresolved recovery", 409, "RELEASE_IN_PROGRESS");
  await releaseStore.invalidate(projectId);
}
export const assertGitopsCommand = createGitopsGate({
  ...releaseStore, workflow: releaseWorkflow,
  async verifyTarget(ctx, binding, plan, command) {
    if (!plan.current.serverEnvironmentHash || await serverEnvironmentHash(binding.projectId, binding.environment) !== plan.current.serverEnvironmentHash)
      throw new AppError("Server environment changed since the release plan was created", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH");
    const manifest = YAML.parse(await githubFile(ctx, binding, binding.manifestPath, command.commitSha!));
    if (manifestHash(manifest) !== plan.target.manifestHash)
      throw new AppError("Deployment manifest differs from the frozen release plan", 409, "RELEASE_EXECUTION_TARGET_MISMATCH");
    const templatePath = `stacks/${binding.stack}/compose.template.yml`;
    const template = await githubFile(ctx, binding, templatePath, command.commitSha!);
    const config = YAML.parse(await githubFile(ctx, binding, "platform.yaml", plan.target.workflowSha)) as { stacks: Array<GitopsComposeContract & { name: string; repository: string; templatePath: string; composePath: string }> };
    const stack = config.stacks?.find(s => s.name === binding.stack);
    if (!stack || gitopsConfigurationHash(template, stack) !== plan.target.configurationHash)
      throw new AppError("Compose template differs from the frozen release plan", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH");
    if (binding.stack === "magic-core" && plan.target.services.includes("platform-api")) {
      const expected = plan.target.migration, project = await repos.project.findById(binding.projectId);
      const active = project?.activeDeploymentId ? await repos.deployment.findById(project.activeDeploymentId) : null;
      const rows = await repos.service.listByProject(binding.projectId), saved = active ? await repos.service.listByDeployment(active.id) : [];
      const database = saved.find(row => row.serviceId === rows.find(service => service.name === "magic-postgres")?.id);
      const image = plan.target.images["platform-api"];
      if (!expected || !active || !image?.gitSha || database?.containerId !== expected.databaseContainerId)
        throw new AppError("Migration phase or actual database changed; generate a fresh release plan", 409, "RELEASE_EXECUTION_MIGRATION_MISMATCH");
      const { runtime } = await resolveDeploymentRuntimeForRead(active);
      try {
        if (!(runtime instanceof DockerRuntime)) throw new Error("Actual database host cannot be confirmed");
        const execution = await inspectMigrationExecution(ctx, binding, stack.repository, image.gitSha, runtime, expected.databaseContainerId);
        if (!migrationExecutionMatches(expected, execution))
          throw new AppError("Migration phase, immutable SQL inventory or database history changed", 409, "RELEASE_EXECUTION_MIGRATION_MISMATCH");
      } finally { disposeRuntime(runtime); }
    }
    if (stack.hostConfig) {
      const project = await repos.project.findById(binding.projectId);
      const active = project?.activeDeploymentId ? await repos.deployment.findById(project.activeDeploymentId) : null;
      if (!active) throw new AppError("Actual target host cannot be confirmed", 409, "RELEASE_RUNTIME_UNKNOWN");
      const { runtime } = await resolveDeploymentRuntimeForRead(active);
      try {
        if (!(runtime instanceof DockerRuntime)) throw new AppError("Actual target host cannot be confirmed", 409, "RELEASE_RUNTIME_UNKNOWN");
        await assertReleaseHostConfiguration(ctx, binding, runtime, plan.target.workflowSha);
      } finally { disposeRuntime(runtime); }
    }
    {
      const project = await repos.project.findById(binding.projectId);
      const locked = await githubFile(ctx, binding, project!.composePath!, command.commitSha!);
      if ((command.compose !== undefined && command.compose !== locked) || manifestHash(YAML.parse(locked)) !== manifestHash(YAML.parse(renderGitopsCompose(template, stack!, manifest))))
        throw new AppError("Compose input differs from the immutable GitOps document", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH");
      if (command.compose === undefined) {
        const env: Record<string, string> = {};
        for (const row of await repos.project.listEnvVars(binding.projectId, binding.environment, null)) env[row.key] = decrypt(row.value);
        const parsed = parseComposeFile(locked, { env });
        const rows = await repos.service.listByProject(binding.projectId);
        if (parsed.missingRequired.length || rows.length !== parsed.services.length || parsed.services.some(service => {
          const stored = rows.find(row => row.name === service.name);
          return !stored || !stored.enabled || !composeSpecsEqual(toComposeSpec(stored), composeWritePatch(service, stored, true));
        })) throw new AppError("Stored services differ from the immutable Compose document; sync the registered target first", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH");
      }
    }
  },
});
export async function assertGitopsDeployment(ctx: ExecutionContext, projectId: string, command: GitopsCommand & { serviceIds?: string[] }) {
  assertDeploymentsAvailable();
  if (!await releaseStore.binding(projectId)) return null;
  const rows = await repos.service.listByProject(projectId);
  const ids = command.serviceIds ?? [];
  if (new Set(ids).size !== ids.length || ids.some(id => !rows.some(r => r.id === id && r.enabled)))
    throw new AppError("Deployment contains an unknown or disabled service", 409, "RELEASE_EXECUTION_SCOPE_MISMATCH");
  return assertGitopsCommand(ctx, projectId, { ...command, serviceNames: ids.map(id => rows.find(r => r.id === id)!.name) });
}
