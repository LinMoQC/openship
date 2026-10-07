import { createHash } from "node:crypto";
import { assertDeploymentsAvailable } from "./deployment-maintenance";
import {
  AppError, NotFoundError, parseInput, ReleaseBindingInputSchema, ReleasePlanInputSchema,
  AutomaticReleaseSchema, ReleaseRunInputSchema, RegisterWorkflowSchema, ReleaseProgressSchema, RELEASE_ACTIVE_STAGES,
  type ReleaseBinding, type ReleaseBindingInput, type ReleasePlan, type ReleasePlanInput,
  type ReleaseRun, type ReleaseRunInput, type ReleaseState, type ReleaseTarget, type ReleaseObservation,
  type ReleaseCheck, type ReleaseCapabilities, type ReleaseProgress,
} from "@repo/contracts";
import type { ExecutionContext } from "./context";
import type { Authorization } from "./authorization";
import type { OperationResult } from "./deployments";
import { releaseInspectionFailure } from "./release-diagnostics";

export function releaseHash(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k, canonical(x)]));
    return v;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/** GitOps timestamps are annotations, not release identity. */
export function manifestHash(value: unknown): string {
  if (!value || typeof value !== "object") return releaseHash(value);
  const { updatedAt: _time, ...semantic } = value as Record<string, unknown>;
  return releaseHash(semantic);
}
export function releaseStateKind(current: ReleaseObservation, target: ReleaseTarget | null, checks: ReleaseCheck[]): ReleaseState["kind"] {
  if (!current.verified || !target) return "unknown";
  if (checks.some(c => c.blocking && c.status === "unknown")) return "unknown";
  if (checks.some(c => c.key === "runtime.manifest" && c.status === "fail")) return "drift";
  if (checks.some(c => c.blocking && c.status === "fail")) return "blocked";
  if (releaseHash(current.images) !== releaseHash(target.images) || current.ossGitSha !== target.ossGitSha) return "available";
  if (current.configurationHash !== target.configurationHash) return "configuration";
  return "current";
}
export interface WorkflowIdentity {
  id: string; repository: string; workflow: string; headBranch: string; headSha: string;
  actor: string; triggeringActor: string; event: string; title: string; url: string;
  status: string; conclusion: string | null;
}
export interface ReleaseStore {
  binding(projectId: string): Promise<ReleaseBinding | null>;
  bind(ctx: ExecutionContext, projectId: string, input: ReleaseBindingInput): Promise<ReleaseBinding>;
  cache(projectId: string): Promise<ReleaseState | null>;
  saveState(state: ReleaseState): Promise<void>;
  plan(id: string): Promise<ReleasePlan | null>;
  createPlan(plan: ReleasePlan): Promise<void>;
  run(id: string): Promise<ReleaseRun | null>;
  byKey(projectId: string, key: string): Promise<ReleaseRun | null>;
  latest(projectId: string): Promise<ReleaseRun | null>;
  active(projectId: string): Promise<ReleaseRun | null>;
  reserve(run: ReleaseRun, now: Date): Promise<{ run: ReleaseRun; created: boolean }>;
  updateRun(id: string, patch: Partial<ReleaseRun>, expectedStage?: string): Promise<ReleaseRun | null>;
  invalidate(projectId: string): Promise<void>;
}
export interface ReleaseDependencies {
  store: ReleaseStore;
  now(): Date;
  id(prefix: string): string;
  /** Includes live runtime attestation and freshly read GitOps manifests. No inferred success. */
  inspect(ctx: ExecutionContext, binding: ReleaseBinding, input: ReleasePlanInput): Promise<{ current: ReleaseObservation; target: ReleaseTarget; checks: ReleaseCheck[] }>;
  githubActor(ctx: ExecutionContext, binding: ReleaseBinding): Promise<string>;
  dispatch(ctx: ExecutionContext, binding: ReleaseBinding, plan: ReleasePlan, run: ReleaseRun): Promise<void>;
  workflow(ctx: ExecutionContext, binding: ReleaseBinding, id: string): Promise<WorkflowIdentity>;
  reconcile(ctx: ExecutionContext, binding: ReleaseBinding, run: ReleaseRun, plan: ReleasePlan): Promise<WorkflowIdentity | null>;
  verifyAcceptance(ctx: ExecutionContext, binding: ReleaseBinding, plan: ReleasePlan, run: ReleaseRun, progress: ReleaseProgress): Promise<void>;
  afterAcceptance?(run: ReleaseRun): Promise<void>;
  recover?(run: ReleaseRun, plan: ReleasePlan): Promise<"restored" | "action_required">;
  capabilities(): ReleaseCapabilities;
  recordAudit?(ctx: ExecutionContext, projectId: string, operation: string, recordId: string): void;
}
export interface PlatformReleaseOperations {
  state(ctx: ExecutionContext, projectId: string, options?: { fresh?: boolean }): Promise<OperationResult<ReleaseState>>;
  bind(ctx: ExecutionContext, projectId: string, input: unknown): Promise<OperationResult<ReleaseBinding>>;
  plan(ctx: ExecutionContext, projectId: string, input?: unknown): Promise<OperationResult<ReleasePlan>>;
  getPlan(ctx: ExecutionContext, id: string): Promise<OperationResult<ReleasePlan>>;
  start(ctx: ExecutionContext, id: string, input: unknown): Promise<OperationResult<ReleaseRun>>;
  latest(ctx: ExecutionContext, projectId: string): Promise<OperationResult<ReleaseRun | null>>;
  getRun(ctx: ExecutionContext, id: string): Promise<OperationResult<ReleaseRun>>;
  automatic(ctx: ExecutionContext, projectId: string, input: unknown): Promise<OperationResult<ReleaseRun>>;
  register(ctx: ExecutionContext, id: string, input: unknown): Promise<OperationResult<ReleaseRun>>;
  progress(ctx: ExecutionContext, id: string, input: unknown): Promise<OperationResult<ReleaseRun>>;
  capabilities(ctx: ExecutionContext, projectId?: string): Promise<OperationResult<ReleaseCapabilities>>;
}
const conflict = (code: string, message: string): never => { throw new AppError(message, 409, code); };
const blocked = (checks: ReleaseCheck[]) => checks.some(c => c.blocking && c.status !== "pass");
export function createReleaseOperations(authorization: Authorization, dependencies?: ReleaseDependencies): PlatformReleaseOperations {
  const deps = () => { if (!dependencies) throw new AppError("GitOps releases are unavailable", 501, "CAPABILITY_UNAVAILABLE"); return dependencies; };
  async function authorized(ctx: ExecutionContext, projectId: string, action: "read" | "write" | "admin") {
    return authorization.authorize(ctx, { resourceType: "project", resourceId: projectId, action });
  }
  async function binding(ctx: ExecutionContext, projectId: string) {
    const row = await deps().store.binding(projectId);
    if (!row || row.organizationId !== ctx.organizationId) throw new NotFoundError("Release binding", projectId);
    return row;
  }
  async function planFor(ctx: ExecutionContext, id: string, action: "read" | "write" | "admin" = "read") {
    const plan = await deps().store.plan(id);
    if (!plan) throw new NotFoundError("Release plan", id);
    const context = await authorized(ctx, plan.projectId, action);
    if (context.organizationId !== plan.organizationId) throw new NotFoundError("Release plan", id);
    return { context, plan };
  }
  async function runFor(ctx: ExecutionContext, id: string, action: "read" | "write" = "read") {
    const run = await deps().store.run(id);
    if (!run) throw new NotFoundError("Release run", id);
    const context = await authorized(ctx, run.projectId, action);
    if (context.organizationId !== run.organizationId) throw new NotFoundError("Release run", id);
    return { context, run, binding: await binding(context, run.projectId) };
  }
  async function controller(ctx: ExecutionContext, b: ReleaseBinding, run: ReleaseRun) {
    if (!ctx.tokenScope || !b.controllerTokenIds.includes(ctx.tokenScope.tokenId)) throw new AppError("A bound controller token is required", 403, "RELEASE_CONTROLLER_REQUIRED");
    if (!run.workflowRunId) conflict("RELEASE_WORKFLOW_UNREGISTERED", "Register the authenticated workflow first");
    const plan = await deps().store.plan(run.planId);
    if (!plan || plan.bindingRevision !== b.revision) conflict("RELEASE_BINDING_CHANGED", "Release binding changed");
    assertWorkflow(b, plan!, run, await deps().workflow(ctx, b, run.workflowRunId!));
    return plan!;
  }
  return Object.freeze({
    async state(ctx, projectId, options = {}) {
      const context = await authorized(ctx, projectId, "read");
      const b = await binding(context, projectId);
      const last = await deps().store.cache(projectId);
      if (!options.fresh && last && !last.stale && deps().now().getTime() - Date.parse(last.checkedAt) < 300_000 && last.binding.revision === b.revision) return { context, data: last };
      const checkedAt = deps().now().toISOString();
      try {
        const fresh = await deps().inspect(context, b, {});
        const data: ReleaseState = { binding: b, ...fresh, kind: releaseStateKind(fresh.current, fresh.target, fresh.checks), checkedAt, stale: false, error: null };
        await deps().store.saveState(data);
        return { context, data };
      } catch (error) {
        // Retain evidence from the last successful poll; it is never reported as current.
        const failure = releaseInspectionFailure(error);
        return { context, data: { binding: b, current: last?.current ?? { deploymentId: null, images: {}, configurationHash: null, ossGitSha: null, verified: false }, target: last?.target ?? null,
          checks: [failure, ...(last?.checks ?? []).filter(check => !check.key.startsWith("inspection."))], kind: "unknown", checkedAt: last?.checkedAt ?? deps().now().toISOString(), stale: true, error: failure.detail } };
      }
    },
    async bind(ctx, projectId, value) {
      const input = parseInput(ReleaseBindingInputSchema, value);
      const context = await authorized(ctx, projectId, "admin");
      if (await deps().store.active(projectId)) conflict("RELEASE_IN_PROGRESS", "Cannot change a binding while a release is executing");
      if (input.manifestPath !== `stacks/${input.stack}/release.yaml` || input.targetBranch !== (input.environment === "preview" ? "deploy/prt" : "deploy/prod")) throw new AppError("Binding environment and manifest do not match", 400, "INVALID_RELEASE_BINDING");
      // Binding does not create history. Attest the actual runtime on registration;
      // unresolved evidence remains unknown and cannot authorize a release.
      const row = await deps().store.bind(context, projectId, input);
      const checkedAt = deps().now().toISOString();
      try {
        const fresh = await deps().inspect(context, row, {});
        await deps().store.saveState({ binding: row, ...fresh, kind: releaseStateKind(fresh.current, fresh.target, fresh.checks), checkedAt, stale: false, error: null });
      } catch (error) {
        const failure = releaseInspectionFailure(error);
        await deps().store.saveState({ binding: row, current: { deploymentId: null, images: {}, configurationHash: null, ossGitSha: null, verified: false }, target: null, checks: [failure], kind: "unknown", checkedAt, stale: true, error: failure.detail });
      }
      deps().recordAudit?.(context, projectId, "releaseBind", row.id);
      return { context, data: row };
    },
    async plan(ctx, projectId, value = {}) {
      const input = parseInput(ReleasePlanInputSchema, value);
      const context = await authorized(ctx, projectId, "write");
      const b = await binding(context, projectId);
      const fresh = await deps().inspect(context, b, input);
      const createdAt = deps().now();
      const snapshot = { bindingRevision: b.revision, current: fresh.current, target: fresh.target, checks: fresh.checks };
      const plan: ReleasePlan = { id: deps().id("rlp"), projectId, organizationId: context.organizationId, ...snapshot,
        summaryHash: releaseHash(snapshot), createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 600_000).toISOString(), consumedAt: null };
      await deps().store.createPlan(plan);
      deps().recordAudit?.(context, projectId, "releasePlan", plan.id);
      return { context, data: plan };
    },
    async getPlan(ctx, id) { const { context, plan } = await planFor(ctx, id); return { context, data: plan }; },
    async start(ctx, id, value) {
      const input: ReleaseRunInput = parseInput(ReleaseRunInputSchema, value);
      const { context, plan } = await planFor(ctx, id, "write");
      const b = await binding(context, plan.projectId);
      const existing = await deps().store.byKey(plan.projectId, input.idempotencyKey);
      if (existing) { if (existing.planId !== id || existing.userId !== context.userId) conflict("RELEASE_IDEMPOTENCY_CONFLICT", "This key belongs to a different release"); return { context, data: existing }; }
      assertDeploymentsAvailable();
      if (b.environment === "production") {
        await authorized(context, plan.projectId, "admin");
        if (input.confirm !== "production") throw new AppError("Type production to confirm this target", 400, "PRODUCTION_CONFIRMATION_REQUIRED");
      }
      if (plan.bindingRevision !== b.revision) conflict("RELEASE_BINDING_CHANGED", "Generate a new plan for the changed binding");
      if (Date.parse(plan.expiresAt) <= deps().now().getTime()) conflict("RELEASE_PLAN_EXPIRED", "This plan expired. Generate a new plan.");
      if (plan.consumedAt) conflict("RELEASE_PLAN_CONSUMED", "This plan has already been submitted");
      if (context.tokenScope || context.source === "mcp") throw new AppError("Connect your GitHub OAuth identity to submit releases", 403, "GITHUB_USER_CONNECTION_REQUIRED");
      const actor = await deps().githubActor(context, b);
      const fresh = await deps().inspect(context, b, { action: plan.target.action, ...(plan.target.eventKey ? { eventKey: plan.target.eventKey } : {}), manifestCommit: plan.target.manifestCommit });
      if (releaseHash(fresh.current) !== releaseHash(plan.current) || releaseHash(fresh.target) !== releaseHash(plan.target)) conflict("RELEASE_PLAN_CHANGED", "Runtime or target changed. Generate a new plan.");
      if (blocked(fresh.checks)) conflict("RELEASE_PREFLIGHT_BLOCKED", "Resolve every blocking check before submitting");
      const now = deps().now().toISOString();
      const reserved = await deps().store.reserve({ id: deps().id("rlr"), projectId: plan.projectId, organizationId: plan.organizationId, planId: plan.id, userId: context.userId, githubActor: actor,
        origin: "user", idempotencyKey: input.idempotencyKey, stage: "submitted", workflowRunId: null, workflowUrl: null, deploymentId: null, receipt: null, error: null, createdAt: now, updatedAt: now }, deps().now());
      if (!reserved.created) return { context, data: reserved.run };
      deps().recordAudit?.(context, plan.projectId, "releaseSubmit", reserved.run.id);
      try { await deps().dispatch(context, b, plan, reserved.run); }
      catch (error) {
        // A request timeout does not establish failure. Persist ambiguity and reconcile by run name. Never repeat dispatch.
        const rejected = error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && ![408, 429].includes(error.statusCode);
        await deps().store.updateRun(reserved.run.id, { stage: rejected ? "failed" : "dispatch_unknown", error: rejected ? "GitHub rejected workflow submission. Reconnect your account or check repository permissions." : "Workflow submission result is pending confirmation" }, "submitted");
      }
      return { context, data: (await deps().store.run(reserved.run.id))! };
    },
    async latest(ctx, projectId) {
      const context = await authorized(ctx, projectId, "read");
      await binding(context, projectId);
      const run = await deps().store.latest(projectId);
      return { context, data: run && run.organizationId === context.organizationId ? run : null };
    },
    async getRun(ctx, id) {
      const { context, binding: b, run } = await runFor(ctx, id);
      if (run.stage === "recovering") {
        const plan = (await deps().store.plan(run.planId))!;
        try {
          const stage = await deps().recover?.(run, plan) ?? "action_required";
          return { context, data: await deps().store.updateRun(id, { stage, error: stage === "restored" ? "Previous containers were restored and verified" : "Manual recovery or reconciliation is required" }, "recovering") ?? run };
        } catch (error) {
          if (error instanceof AppError && error.code === "RELEASE_RECOVERY_PENDING") return { context, data: run };
          return { context, data: await deps().store.updateRun(id, { stage: "action_required", error: "Container recovery could not be verified" }, "recovering") ?? run };
        }
      }
      if (["submitted", "dispatch_unknown"].includes(run.stage) && !run.workflowRunId) {
        const plan = (await deps().store.plan(run.planId))!;
        const workflow = await deps().reconcile(context, b, run, plan);
        if (workflow) {
          assertWorkflow(b, plan, run, workflow);
          const updated = await deps().store.updateRun(id, { stage: "queued", workflowRunId: workflow.id, workflowUrl: workflow.url, error: null }, run.stage);
          return { context, data: updated ?? run };
        }
      }
      if (run.workflowRunId && RELEASE_ACTIVE_STAGES.includes(run.stage as typeof RELEASE_ACTIVE_STAGES[number])) {
        const plan = (await deps().store.plan(run.planId))!;
        const workflow = await deps().workflow(context, b, run.workflowRunId);
        assertWorkflow(b, plan, run, workflow);
        if (workflow.status === "completed") {
          // GitHub success is not external acceptance. Preserve any changed
          // runtime for explicit recovery rather than guessing its final state.
          const updated = await deps().store.updateRun(id, { stage: run.deploymentId ? "action_required" : "failed", error: "Workflow completed without a verified acceptance outcome. Check its logs and recovery state." }, run.stage);
          return { context, data: updated ?? run };
        }
      }
      return { context, data: run };
    },
    async automatic(ctx, projectId, value) {
      const input = parseInput(AutomaticReleaseSchema, value);
      const context = await authorized(ctx, projectId, "write");
      assertDeploymentsAvailable();
      const b = await binding(context, projectId);
      if (b.environment !== "preview" || !context.tokenScope || !b.controllerTokenIds.includes(context.tokenScope.tokenId)) throw new AppError("Automatic releases require the bound PRT controller", 403, "RELEASE_CONTROLLER_REQUIRED");
      const workflow = await deps().workflow(context, b, input.workflowRunId);
      if (workflow.repository !== b.repository || workflow.workflow !== b.workflows.preview || workflow.headBranch !== "main" || !["schedule", "repository_dispatch", "workflow_dispatch"].includes(workflow.event) || workflow.title !== `GitOps automation ${workflow.id}` || workflow.actor !== workflow.triggeringActor)
        throw new AppError("Automatic workflow identity is invalid", 403, "RELEASE_WORKFLOW_IDENTITY_MISMATCH");
      const idempotencyKey = `automatic_${input.workflowRunId}_${input.eventKey}`;
      const previous = await deps().store.byKey(projectId, idempotencyKey);
      if (previous) return { context, data: previous };
      const fresh = await deps().inspect(context, b, { eventKey: input.eventKey, manifestCommit: input.manifestCommit });
      if (workflow.headSha !== fresh.target.workflowSha) conflict("RELEASE_PLAN_CHANGED", "Automatic workflow source no longer matches the current GitOps contract");
      if (blocked(fresh.checks)) conflict("RELEASE_PREFLIGHT_BLOCKED", "Automatic execution preflight is blocked");
      const now = deps().now();
      const snapshot = { bindingRevision: b.revision, ...fresh };
      const plan: ReleasePlan = { id: deps().id("rlp"), projectId, organizationId: context.organizationId, ...snapshot, summaryHash: releaseHash(snapshot), createdAt: now.toISOString(), expiresAt: new Date(+now + 600_000).toISOString(), consumedAt: null };
      await deps().store.createPlan(plan);
      const reserved = await deps().store.reserve({ id: deps().id("rlr"), projectId, organizationId: context.organizationId, planId: plan.id, userId: context.userId, githubActor: workflow.actor, origin: "automatic", idempotencyKey, stage: "queued", workflowRunId: workflow.id, workflowUrl: workflow.url, deploymentId: null, receipt: null, error: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }, now);
      deps().recordAudit?.(context, projectId, "releaseAutomatic", reserved.run.id);
      return { context, data: reserved.run };
    },
    async register(ctx, id, value) {
      const input = parseInput(RegisterWorkflowSchema, value);
      const { context, binding: b, run } = await runFor(ctx, id, "write");
      if (!context.tokenScope || !b.controllerTokenIds.includes(context.tokenScope.tokenId)) throw new AppError("A bound controller token is required", 403, "RELEASE_CONTROLLER_REQUIRED");
      if (run.workflowRunId && run.workflowRunId !== input.workflowRunId) conflict("RELEASE_WORKFLOW_CONFLICT", "Another workflow already owns this run");
      if (!RELEASE_ACTIVE_STAGES.includes(run.stage as typeof RELEASE_ACTIVE_STAGES[number])) conflict("RELEASE_RUN_TERMINAL", "This release has already completed");
      const plan = (await deps().store.plan(run.planId))!;
      const workflow = await deps().workflow(context, b, input.workflowRunId);
      assertWorkflow(b, plan, run, workflow);
      // A retry after deployment began verifies ownership without resetting progress.
      if (run.workflowRunId) return { context, data: run };
      // Queued plans can exceed their expiry. Recheck the frozen plan and live gates before execution.
      const fresh = await deps().inspect(context, b, { action: plan.target.action, eventKey: plan.target.eventKey ?? undefined, manifestCommit: plan.target.manifestCommit });
      if (plan.bindingRevision !== b.revision || releaseHash(fresh.current) !== releaseHash(plan.current) || releaseHash(fresh.target) !== releaseHash(plan.target)) {
        await deps().store.updateRun(id, { stage: "failed", error: "Runtime or target changed while queued. Generate a new plan." }, run.stage);
        conflict("RELEASE_PLAN_CHANGED", "Runtime or target changed while queued");
      }
      if (blocked(fresh.checks)) {
        await deps().store.updateRun(id, { stage: "failed", error: "Execution preflight is blocked. Generate a new plan after resolving the checks." }, run.stage);
        conflict("RELEASE_PREFLIGHT_BLOCKED", "Execution preflight is blocked");
      }
      const updated = await deps().store.updateRun(id, { stage: "queued", workflowRunId: input.workflowRunId, workflowUrl: workflow.url, error: null }, run.stage);
      if (!updated) conflict("RELEASE_STAGE_CONFLICT", "Release changed during registration. Read its current state.");
      deps().recordAudit?.(context, b.projectId, "releaseRegister", id);
      return { context, data: updated! };
    },
    async progress(ctx, id, value) {
      const input: ReleaseProgress = parseInput(ReleaseProgressSchema, value);
      const { context, binding: b, run } = await runFor(ctx, id, "write");
      const plan = await controller(context, b, run);
      if (input.deploymentId && input.deploymentId !== run.deploymentId && !(["verifying", "accepted"].includes(input.stage) && plan.target.services.length === 0 && input.deploymentId === plan.current.deploymentId))
        conflict("RELEASE_DEPLOYMENT_CONFLICT", "Deployment ownership must be registered atomically when the deployment is created");
      if (!RELEASE_ACTIVE_STAGES.includes(run.stage as typeof RELEASE_ACTIVE_STAGES[number])) {
        if (run.stage === input.stage && run.deploymentId === (input.deploymentId ?? run.deploymentId)) return { context, data: run };
        conflict("RELEASE_RUN_TERMINAL", "A terminal release cannot change outcome");
      }
      assertReleaseTransition(run.stage, input.stage);
      if (input.stage === "restored") conflict("RELEASE_RECOVERY_REQUIRED", "Only verified container recovery can establish restoration");
      if (input.stage === "accepted") { await deps().verifyAcceptance(context, b, plan, run, input); await deps().store.invalidate(run.projectId); }
      const updated = await deps().store.updateRun(id, { ...input, receipt: input.receipt ?? run.receipt, deploymentId: input.deploymentId ?? run.deploymentId, error: input.error ?? null }, run.stage);
      if (!updated) conflict("RELEASE_STAGE_CONFLICT", "Release changed during progress update. Read its current state.");
      if (input.stage === "accepted") {
        await deps().afterAcceptance?.(updated!);
        // Refresh after verified acceptance; a failed poll leaves the cache
        // invalidated without rewriting the durable accepted outcome.
        const checkedAt = deps().now().toISOString();
        try {
          const fresh = await deps().inspect(context, b, {});
          await deps().store.saveState({ binding: b, ...fresh, kind: releaseStateKind(fresh.current, fresh.target, fresh.checks), checkedAt, stale: false, error: null });
        } catch { /* Last successful evidence remains stale until the next poll. */ }
      }
      if (input.stage === "recovering") {
        let stage: "restored" | "action_required" = "action_required";
        try { stage = await deps().recover?.(updated!, plan) ?? "action_required"; }
        catch (error) {
          if (error instanceof AppError && error.code === "RELEASE_RECOVERY_PENDING")
            return { context, data: updated! };
          // The journal retains failures for manual recovery.
        }
        const recovered = await deps().store.updateRun(id, { stage, error: stage === "restored" ? "Previous containers were restored and verified" : "Manual recovery or reconciliation is required" }, "recovering");
        await deps().store.invalidate(run.projectId);
        return { context, data: recovered ?? updated! };
      }
      deps().recordAudit?.(context, b.projectId, `release:${input.stage}`, id);
      return { context, data: updated! };
    },
    async capabilities(ctx, projectId) { return { context: await authorization.authorize(ctx, projectId ? { resourceType: "project", resourceId: projectId, action: "read" } : { resourceType: "updates", resourceId: "*", action: "read" }), data: deps().capabilities() }; },
  } satisfies PlatformReleaseOperations);
}
export function assertWorkflow(b: ReleaseBinding, plan: ReleasePlan, run: ReleaseRun, workflow: WorkflowIdentity) {
  const expected = plan.target.action === "rollback" ? b.workflows.rollback : b.environment === "preview" ? b.workflows.preview : b.workflows.production;
  const automatic = run.origin === "automatic";
  const eventMatches = automatic ? b.environment === "preview" && ["schedule", "repository_dispatch", "workflow_dispatch"].includes(workflow.event) : workflow.event === "workflow_dispatch";
  const title = automatic ? `GitOps automation ${workflow.id}` : `GitOps release ${run.id}`;
  if (!eventMatches || workflow.repository !== b.repository || workflow.workflow !== expected || workflow.headBranch !== "main" || workflow.headSha !== plan.target.workflowSha || workflow.actor !== run.githubActor || workflow.triggeringActor !== run.githubActor || workflow.title !== title) {
    throw new AppError("Workflow identity does not match the saved release plan", 403, "RELEASE_WORKFLOW_IDENTITY_MISMATCH");
  }
}
export function assertReleaseTransition(from: ReleaseRun["stage"], to: ReleaseRun["stage"]) {
  const order = ["checking", "submitted", "dispatch_unknown", "queued", "syncing", "pulling", "deploying", "health", "verifying", "accepted"];
  if (from === to) return;
  if (["failed", "recovering", "action_required"].includes(to)) return;
  if (from === "recovering" && ["restored", "action_required"].includes(to)) return;
  if (order.indexOf(to) < 0 || order.indexOf(from) < 0 || order.indexOf(to) < order.indexOf(from)) conflict("RELEASE_STAGE_CONFLICT", "Release progress cannot move backwards");
}
