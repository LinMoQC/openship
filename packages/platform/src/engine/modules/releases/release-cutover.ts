import { DockerRuntime, type ServiceCutoverRecord } from "@repo/adapters";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import type { ReleasePlan, ReleaseRun } from "@repo/contracts";
import { resolveDeploymentRuntimeForRead, disposeRuntime } from "../../lib/deployment-runtime";
import { registerStartupHook } from "../../lib/startup/index";

function recordOf(row: Awaited<ReturnType<typeof repos.releases.journals>>[number]): ServiceCutoverRecord {
  const c = row.context;
  if (!c || typeof c.containerName !== "string" || typeof c.preflightName !== "string" || typeof c.retainedName !== "string" ||
      typeof c.releaseRunId !== "string" || typeof c.timeoutMs !== "number" || typeof c.wasRunning !== "boolean" || typeof c.hadHealthcheck !== "boolean" ||
      !(c.previousDeploymentId === null || typeof c.previousDeploymentId === "string") || !(c.preflightId === null || typeof c.preflightId === "string"))
    throw new AppError("Cutover journal is incomplete; manual recovery required", 409, "RELEASE_RECOVERY_REQUIRED");
  return { ...row, context: c as unknown as ServiceCutoverRecord["context"] };
}

export async function settleReleaseCutovers(run: ReleaseRun, decision: "commit" | "restore") {
  const rows = (await repos.releases.journals(run.projectId)).filter(row => row.context.releaseRunId === run.id);
  for (const row of rows) {
    const record = recordOf(row), deployment = await repos.deployment.findById(record.deploymentId);
    if (!deployment || deployment.organizationId !== run.organizationId || deployment.projectId !== run.projectId ||
        (deployment.meta as { releaseRunId?: string } | null)?.releaseRunId !== run.id)
      throw new AppError("Cutover journal ownership cannot be verified", 409, "RELEASE_RECOVERY_REQUIRED");
    if (await repos.deployment.hasLiveBuildExecution(deployment.id, run.projectId))
      throw new AppError("Deployment worker has not finished; recovery remains pending", 409, "RELEASE_RECOVERY_PENDING");
    const { runtime } = await resolveDeploymentRuntimeForRead(deployment);
    try {
      if (!(runtime instanceof DockerRuntime)) throw new AppError("Docker recovery runtime is unavailable", 409, "RELEASE_RECOVERY_REQUIRED");
      await runtime.settleServiceCutover(record, decision, async value => {
        if (!(await repos.releases.journal(value))) throw new AppError("Cutover journal ownership changed", 409, "RELEASE_RECOVERY_REQUIRED");
      });
    } finally { disposeRuntime(runtime); }
  }
}

/** Restore only opt-in stateless services. A mixed Core release is never reported
 * as restored wholesale, and neither schema nor business volumes are changed. */
export async function recoverReleaseCutovers(run: ReleaseRun, plan: ReleasePlan): Promise<"restored" | "action_required"> {
  await settleReleaseCutovers(run, "restore");
  const journals = (await repos.releases.journals(run.projectId)).filter(row => row.context.releaseRunId === run.id);
  if (!journals.length || !plan.target.services.every(name => journals.some(row => row.serviceName === name && row.stage === "restored" && row.incumbentId)))
    return "action_required";
  const previousIds = new Set(journals.map(row => row.context.previousDeploymentId));
  if (previousIds.size !== 1 || !previousIds.has(plan.current.deploymentId)) return "action_required";
  const project = await repos.project.findById(run.projectId);
  const previous = plan.current.deploymentId ? await repos.deployment.findById(plan.current.deploymentId) : null;
  if (!project || !previous || previous.organizationId !== run.organizationId || previous.environment !== project.environmentType ||
      ![previous.id, run.deploymentId].includes(project.activeDeploymentId)) return "action_required";
  const { runtime } = await resolveDeploymentRuntimeForRead(previous);
  try {
    if (!(runtime instanceof DockerRuntime)) return "action_required";
    const services = await repos.service.listByProject(run.projectId), rows = await repos.service.listByDeployment(previous.id);
    for (const [name, image] of Object.entries(plan.current.images)) {
      const service = services.find(s => s.name === name), row = rows.find(r => r.serviceId === service?.id);
      if (!row?.containerId) return "action_required";
      const actual = await runtime.inspectReleaseContainer(row.containerId, image.image);
      if (actual.projectId !== run.projectId || actual.digest !== image.digest || !actual.running || (actual.health !== null && actual.health !== "healthy")) return "action_required";
    }
    await repos.project.setActiveDeployment(project.id, previous.id);
    if (run.deploymentId) await repos.deployment.updateStatus(run.deploymentId, "failed");
    await repos.releases.invalidate(run.projectId);
    return "restored";
  } finally { disposeRuntime(runtime); }
}

export async function recoverInterruptedReleaseCutovers() {
    const pending = await repos.releases.pendingJournals();
    const ids = [...new Set(pending.map(row => String(row.context.releaseRunId)))];
    for (const id of ids) {
      const row = await repos.releases.run(id), planRow = row ? await repos.releases.plan(row.planId) : null;
      if (!row || !planRow) throw new AppError("Pending cutover has no release owner", 409, "RELEASE_RECOVERY_REQUIRED");
      const run: ReleaseRun = { ...row, origin: row.origin as ReleaseRun["origin"], stage: row.stage as ReleaseRun["stage"], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
      const plan = { ...planRow.snapshot, id: planRow.id, projectId: planRow.projectId, organizationId: planRow.organizationId } as unknown as ReleasePlan;
      if (run.stage === "accepted") {
        await settleReleaseCutovers(run, "commit");
      } else {
        await repos.releases.updateRun(id, { stage: "recovering", error: "Control platform restarted before external acceptance; checking retained containers" });
        try {
          const stage = await recoverReleaseCutovers(run, plan);
          await repos.releases.updateRun(id, { stage, error: stage === "restored" ? "Previous containers restored after interrupted cutover" : "Interrupted release includes services requiring manual reconciliation" }, "recovering");
        } catch (error) {
          if (error instanceof AppError && error.code === "RELEASE_RECOVERY_PENDING") continue;
          await repos.releases.updateRun(id, { stage: "action_required", error: "Interrupted cutover recovery could not be verified" }, "recovering");
        }
      }
    }
}

export function registerReleaseCutoverRecovery() {
  registerStartupHook({ id: "gitops-cutover-recovery", modes: ["selfhosted", "desktop"], run: recoverInterruptedReleaseCutovers });
}
