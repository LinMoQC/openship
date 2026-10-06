import { AppError, RELEASE_ACTIVE_STAGES, type ReleaseBinding, type ReleasePlan, type ReleaseRun } from "@repo/contracts";
import type { ExecutionContext } from "./context";
import { assertDeploymentsAvailable } from "./deployment-maintenance";
import { assertWorkflow, releaseHash, type WorkflowIdentity } from "./releases";

export interface GitopsCommand {
  releaseRunId?: string;
  environment?: string;
  commitSha?: string;
  strictServiceScope?: boolean;
  forceAll?: boolean;
  refresh?: boolean;
  smartRoute?: boolean;
  serviceNames?: string[];
  expectedServices?: string[];
  compose?: string;
}
export interface GitopsGateDependencies {
  binding(projectId: string): Promise<ReleaseBinding | null>;
  run(id: string): Promise<ReleaseRun | null>;
  plan(id: string): Promise<ReleasePlan | null>;
  workflow(ctx: ExecutionContext, binding: ReleaseBinding, id: string): Promise<WorkflowIdentity>;
  verifyTarget(ctx: ExecutionContext, binding: ReleaseBinding, plan: ReleasePlan, command: GitopsCommand): Promise<void>;
}
function refuse(projectId: string): never {
  throw new AppError(`This GitOps project requires a registered release controller. Create a plan at /api/projects/${encodeURIComponent(projectId)}/release-plans.`, 409, "GITOPS_RELEASE_REQUIRED");
}

/** Every transport calls this boundary before any deployment or Compose mutation. */
export function createGitopsGate(deps: GitopsGateDependencies) {
  return async (ctx: ExecutionContext, projectId: string, command: GitopsCommand = {}) => {
    assertDeploymentsAvailable();
    const binding = await deps.binding(projectId);
    if (!binding) return null;
    if (!command.releaseRunId) refuse(projectId);
    if (binding.organizationId !== ctx.organizationId || !ctx.tokenScope || !binding.controllerTokenIds.includes(ctx.tokenScope.tokenId))
      throw new AppError("A bound controller token is required", 403, "RELEASE_CONTROLLER_REQUIRED");
    const run = await deps.run(command.releaseRunId!);
    if (!run || run.projectId !== projectId || run.organizationId !== ctx.organizationId || !run.workflowRunId || !RELEASE_ACTIVE_STAGES.includes(run.stage as typeof RELEASE_ACTIVE_STAGES[number]) || ["checking", "submitted", "dispatch_unknown", "recovering"].includes(run.stage))
      throw new AppError("Release execution context is missing, inactive or unregistered", 409, "RELEASE_EXECUTION_INVALID");
    const plan = await deps.plan(run.planId);
    if (!plan || plan.projectId !== projectId || plan.organizationId !== ctx.organizationId || plan.bindingRevision !== binding.revision || !plan.consumedAt)
      throw new AppError("The registered release plan no longer matches its binding", 409, "RELEASE_BINDING_CHANGED");
    assertWorkflow(binding, plan, run, await deps.workflow(ctx, binding, run.workflowRunId));
    if (command.environment !== binding.environment || !/^[a-f0-9]{40}$/.test(command.commitSha ?? ""))
      throw new AppError("An exact environment and immutable manifest commit are required", 409, "RELEASE_EXECUTION_TARGET_MISMATCH");
    if (command.compose !== undefined) {
      if (releaseHash([...(command.expectedServices ?? [])].sort()) !== releaseHash([...binding.expectedServices].sort()))
        throw new AppError("Compose sync must match the complete bound service set", 409, "RELEASE_EXECUTION_SCOPE_MISMATCH");
    } else if (command.forceAll || command.refresh || command.smartRoute || !command.strictServiceScope || !command.serviceNames?.length || releaseHash([...command.serviceNames].sort()) !== releaseHash([...plan.target.services].sort())) {
      throw new AppError("Deployment must use exactly the frozen plan's service scope", 409, "RELEASE_EXECUTION_SCOPE_MISMATCH");
    }
    await deps.verifyTarget(ctx, binding, plan, command);
    return { run, plan, binding };
  };
}

/** Internal legacy entry points have no release execution context and cannot acquire one implicitly. */
export async function requireUnmanagedProject(projectId: string, binding: GitopsGateDependencies["binding"]): Promise<void> {
  assertDeploymentsAvailable();
  if (await binding(projectId)) refuse(projectId);
}
