import { AppError, generateId } from "@repo/core";
import { repos } from "@repo/db";
import { DockerRuntime } from "@repo/adapters";
import type { ReleaseDependencies } from "../../../releases";
import { releaseHash, manifestHash } from "../../../releases";
import { releaseStore } from "./release-store";
import { inspectRelease } from "./release-inspector";
import { dispatchRelease, releaseGithubActor, releaseWorkflow, reconcileRelease, githubFile } from "./release-github";
import { resolveDeploymentRuntimeForRead, disposeRuntime } from "../../lib/deployment-runtime";
import { APP_VERSION } from "../../lib/app-version";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { settleReleaseCutovers, recoverReleaseCutovers } from "./release-cutover";
import { releaseTopologyVerifier, assertReleaseHostConfiguration } from "./release-topology";
import { serverEnvironmentHash } from "./release-gate";
export const releaseDependencies: ReleaseDependencies = {
  store: releaseStore, now: () => new Date(), id: generateId, inspect: inspectRelease,
  async afterAcceptance(run) {
    // Acceptance was persisted before cleanup. A restart will retry pending cleanup
    // and must never restore an already accepted release.
    try { await settleReleaseCutovers(run, "commit"); }
    catch { console.warn(`[release] retained container cleanup pending for ${run.id}`); }
  },
  recover: recoverReleaseCutovers,
  githubActor: releaseGithubActor, dispatch: dispatchRelease, workflow: releaseWorkflow, reconcile: reconcileRelease,
  recordAudit(ctx, projectId, operation, recordId) {
    audit.recordAsync(operationAuditContext(ctx), { eventType: "project:write", resourceType: "project", resourceId: projectId, after: { operation, recordId } });
  },
  capabilities: () => ({ runtimeVersion: APP_VERSION, contractVersion: 1, upstreamCommit: "234d8a9d0bd571aff3fe3ce73a8408f226dcb4a0", gitops: true, serverEnvironment: true, strictServiceScope: true, durableCutover: true }),
  async verifyAcceptance(ctx, b, plan, run, progress) {
    const receipt = progress.receipt;
    const noop = receipt?.status === "noop" && plan.target.services.length === 0;
    if (!receipt || (!noop && receipt.status !== "accepted") || receipt.projectId !== b.projectId || receipt.environment !== b.environment || receipt.workflowRun !== run.workflowRunId || typeof receipt.manifestCommit !== "string" || !/^[a-f0-9]{40}$/.test(receipt.manifestCommit) || manifestHash(receipt.manifest) !== plan.target.manifestHash || releaseHash(receipt.services) !== releaseHash(plan.target.services) || receipt.deploymentId !== progress.deploymentId) throw new AppError("Acceptance receipt does not match the frozen target and execution scope", 409, "RELEASE_ACCEPTANCE_MISMATCH");
    const expectedKey = plan.target.action === "verify" ? releaseHash({ verificationRunId: run.id }) : plan.target.eventKey;
    if (noop && (receipt.key !== expectedKey || receipt.deploymentId !== plan.current.deploymentId || plan.current.configurationHash !== plan.target.configurationHash)) throw new AppError("No-op target differs from the actual incumbent", 409, "RELEASE_ACCEPTANCE_MISMATCH");
    const saved = JSON.parse(await githubFile(ctx, b, noop ? `receipts/${expectedKey}.json` : `accepted/${b.stack}/${receipt.manifestCommit}.json`, "release-audit"));
    if (releaseHash(saved) !== releaseHash(receipt)) throw new AppError("Acceptance receipt is not the immutable GitOps record", 409, "RELEASE_ACCEPTANCE_MISMATCH");
    const project = await repos.project.findById(b.projectId), deployment = await repos.deployment.findById(String(progress.deploymentId));
    if (!deployment || project?.activeDeploymentId !== deployment.id || deployment.organizationId !== b.organizationId || deployment.environment !== b.environment || deployment.commitSha !== receipt.manifestCommit || deployment.status !== "ready") throw new AppError("Accepted deployment is not the active ready deployment", 409, "RELEASE_ACTIVE_DEPLOYMENT_MISMATCH");
    const rows = await repos.service.listByDeployment(deployment.id), services = await repos.service.listByProject(project.id);
    if (await serverEnvironmentHash(project.id, b.environment) !== plan.current.serverEnvironmentHash)
      throw new AppError("Server environment changed during release", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH");
    const topology = await releaseTopologyVerifier(ctx, b, deployment);
    const { runtime } = await resolveDeploymentRuntimeForRead(deployment);
    try {
      if (!(runtime instanceof DockerRuntime)) throw new AppError("Actual Docker images cannot be verified", 409, "RELEASE_RUNTIME_UNKNOWN");
      await assertReleaseHostConfiguration(ctx, b, runtime, plan.target.workflowSha);
      for (const [name, image] of Object.entries(plan.target.images)) {
        const service = services.find(s => s.name === name), row = rows.find(r => r.serviceId === service?.id);
        if (!row?.containerId) throw new AppError("Accepted service has no actual container", 409, "RELEASE_RUNTIME_UNKNOWN");
        const actual = await runtime.inspectReleaseContainer(row.containerId, image.image);
        if (topology(name, actual).status !== "pass") throw new AppError("Actual topology differs from the deployed document", 409, "RELEASE_RUNTIME_TOPOLOGY_MISMATCH");
        if (actual.digest !== image.digest || (service?.advanced?.runToCompletion ? actual.running || actual.exitCode !== 0 : !actual.running || (actual.health !== null && actual.health !== "healthy"))) throw new AppError("Actual container does not match the accepted image or health state", 409, "RELEASE_RUNTIME_MISMATCH");
      }
    } finally { disposeRuntime(runtime); }
    for (const url of b.probes) {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (response.status < 200 || response.status >= 400) throw new AppError("External acceptance probe failed", 409, "RELEASE_EXTERNAL_PROBE_FAILED");
    }
  },
};
