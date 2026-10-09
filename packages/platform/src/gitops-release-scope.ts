interface ScopeImage { digest: string; migrationsChanged?: boolean }
interface ScopeManifest { services: Record<string, ScopeImage>; infrastructure?: Record<string, ScopeImage> }
interface ScopeService { name: string; deployServices?: string[]; deployServicesWithMigration?: string[] }

/**
 * A production release deploys every application service whose digest moved,
 * plus every infrastructure service that moved or is new. Infrastructure used
 * to be left out, so a target that adds a service (or refreshes a pinned image)
 * could never converge: the frozen scope excluded exactly what had changed.
 */
export function productionReleaseScope(services: ScopeService[], deployed: ScopeManifest, target: ScopeManifest): string[] {
  const application = services
    .filter(s => deployed.services[s.name]?.digest !== target.services[s.name]!.digest)
    .flatMap(s => target.services[s.name]!.migrationsChanged ? s.deployServicesWithMigration ?? [s.name] : s.deployServices ?? [s.name]);
  const infrastructure = Object.entries(target.infrastructure ?? {})
    .filter(([name, image]) => deployed.infrastructure?.[name]?.digest !== image.digest)
    .map(([name]) => name);
  return [...new Set([...application, ...infrastructure])].sort();
}

export interface RecoveryScopeInput {
  active: { status: string; decision: string | null };
  /** Manifest hashes of the active deployment's own commit, the environment branch and the target. */
  activeHash: string | null; deployedHash: string; targetHash: string;
  /** Configuration hashes of the active deployment's own commit and the target. */
  activeConfiguration: string | null; targetConfiguration: string;
  expected: string[]; unconverged: string[]; tasks: string[];
}

/**
 * A production release whose target is already the desired revision can still
 * be unfinished: a partial_failure left some services on old containers or
 * crash-looping. Only a deployment that attempted exactly this manifest and
 * configuration may be resumed — compared by content, because a later failed
 * attempt can append an identical lock commit to the environment branch — and
 * only the services whose actual container is missing, unhealthy or on another
 * digest are rebuilt. Completion tasks rerun too: only a ready deployment can
 * prove a task that a scoped deploy leaves untouched, and the partial one never will.
 * Any newer deployment attempt marks a pending partial_failure cancelled with
 * decision "superseded" — even one that never touched a container — while the
 * partial one stays active and its containers keep serving. It is still unfinished.
 * An empty result means there is nothing to recover.
 */
export function unfinishedDeployment(active: RecoveryScopeInput["active"]): boolean {
  return active.status === "partial_failure" || (active.status === "cancelled" && active.decision === "superseded");
}
export function productionRecoveryScope(input: RecoveryScopeInput): string[] {
  if (!unfinishedDeployment(input.active) || input.activeHash !== input.targetHash || input.deployedHash !== input.targetHash || input.activeConfiguration !== input.targetConfiguration) return [];
  const unconverged = input.unconverged.filter(name => input.expected.includes(name));
  if (!unconverged.length) return [];
  return [...new Set([...unconverged, ...input.tasks.filter(name => input.expected.includes(name))])].sort();
}

export interface UnacceptedAttemptInput {
  /** The binding's latest release run and the deployment it started. */
  run: { stage: string; deploymentId: string | null } | null;
  attempt: { id: string; status: string } | null;
  activeId: string;
  /** Manifest hashes of the attempt's own commit, the environment branch and the target. */
  attemptHash: string | null; deployedHash: string; targetHash: string;
  attemptConfiguration: string | null; targetConfiguration: string;
  /** Services whose container recorded by the active deployment is not healthy on the target digest. */
  expected: string[]; unconverged: string[]; tasks: string[];
}

/**
 * The PRT twin of the production recovery. A release can replace containers and
 * still fail acceptance; the run then ends terminal and its ready attempt is
 * never activated, so the incumbent's record no longer describes what runs and
 * nothing can be planned. Only an attempt of exactly this manifest and
 * configuration may be resumed, rebuilding every service not on the target
 * digest plus every completion task so the new acceptance proves the whole stack.
 */
export function unacceptedAttemptRecoveryScope(input: UnacceptedAttemptInput): string[] {
  const { run, attempt } = input;
  if (!run || !["action_required", "failed"].includes(run.stage) || !run.deploymentId || !attempt || attempt.id !== run.deploymentId ||
      attempt.id === input.activeId || !["ready", "partial_failure"].includes(attempt.status)) return [];
  if (input.attemptHash !== input.targetHash || input.deployedHash !== input.targetHash || input.attemptConfiguration !== input.targetConfiguration) return [];
  const unconverged = input.unconverged.filter(name => input.expected.includes(name));
  if (!unconverged.length) return [];
  return [...new Set([...unconverged, ...input.tasks.filter(name => input.expected.includes(name))])].sort();
}

/**
 * Platform service rows must equal the bound set, except that a release may add
 * services the bound set declares when every one of them is in its own scope:
 * the release's Compose sync creates them. Any row outside the bound set, or a
 * missing service the release would not deploy, still blocks.
 */
export function runtimeScopeCheck(rows: string[], expected: string[], selected: string[]): { status: "pass" | "fail"; added: string[] } {
  const want = new Set(expected), have = new Set(rows);
  const added = expected.filter(name => !have.has(name)).sort();
  const extra = rows.filter(name => !want.has(name));
  if (extra.length || have.size !== rows.length) return { status: "fail", added };
  return { status: added.every(name => selected.includes(name)) ? "pass" : "fail", added };
}
