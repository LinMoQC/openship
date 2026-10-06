import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../src/context";
import type { ReleaseBinding, ReleasePlan, ReleaseRun } from "@repo/contracts";
import { createGitopsGate, requireUnmanagedProject } from "../src/gitops-gate";
const ctx = { organizationId: "org", tokenScope: { tokenId: "controller" }, source: "api" } as ExecutionContext;
function setup() {
  const binding = { projectId: "p", organizationId: "org", revision: 1, repository: "owner/config", environment: "preview", controllerTokenIds: ["controller"], expectedServices: ["app", "database"], workflows: { preview: "receive.yml" } } as ReleaseBinding;
  const plan = { projectId: "p", organizationId: "org", bindingRevision: 1, consumedAt: "2026-10-06", target: { action: "release", services: ["app"], workflowSha: "a".repeat(40) } } as ReleasePlan;
  const run = { id: "r", projectId: "p", organizationId: "org", planId: "plan", workflowRunId: "123", githubActor: "human", stage: "queued" } as ReleaseRun;
  const workflow = { id: "123", repository: binding.repository, workflow: "receive.yml", headBranch: "main", headSha: plan.target.workflowSha, actor: "human", triggeringActor: "human", event: "workflow_dispatch", title: "GitOps release r", url: "https://github.com/r", status: "in_progress", conclusion: null };
  const deps = { binding: vi.fn(async () => binding as ReleaseBinding | null), run: vi.fn(async () => run), plan: vi.fn(async () => plan), workflow: vi.fn(async () => workflow), verifyTarget: vi.fn(async () => {}) };
  const command = { releaseRunId: "r", environment: "preview", commitSha: "b".repeat(40), strictServiceScope: true, serviceNames: ["app"] };
  return { gate: createGitopsGate(deps), deps, binding, plan, run, workflow, command };
}
describe("shared GitOps deployment gate", () => {
  it.each(["forceAll", "refresh", "smartRoute"])("refuses %s overriding a frozen controller target", async flag => {
    const x = setup();
    await expect(x.gate(ctx, "p", { ...x.command, [flag]: true }))
      .rejects.toMatchObject({ code: "RELEASE_EXECUTION_SCOPE_MISMATCH" });
    expect(x.deps.verifyTarget).not.toHaveBeenCalled();
  });
  it("leaves normal source projects on the upstream deployment path", async () => { const x = setup(); x.deps.binding.mockResolvedValue(null); expect(await x.gate(ctx, "p")).toBeNull(); expect(x.deps.workflow).not.toHaveBeenCalled(); });
  it.each(["dashboard", "cli", "mcp", "webhook", "system", "api"])("rejects an unmanaged %s entry before target inspection", async source => { const x = setup(); await expect(x.gate({ ...ctx, source: source as ExecutionContext["source"] }, "p")).rejects.toMatchObject({ code: "GITOPS_RELEASE_REQUIRED" }); expect(x.deps.verifyTarget).not.toHaveBeenCalled(); });
  it("rejects a wrong token, environment, scope, or workflow", async () => {
    const x = setup();
    await expect(x.gate({ ...ctx, tokenScope: { tokenId: "other" } }, "p", x.command)).rejects.toMatchObject({ code: "RELEASE_CONTROLLER_REQUIRED" });
    await expect(x.gate(ctx, "p", { ...x.command, environment: "production" })).rejects.toMatchObject({ code: "RELEASE_EXECUTION_TARGET_MISMATCH" });
    await expect(x.gate(ctx, "p", { ...x.command, serviceNames: ["app", "database"] })).rejects.toMatchObject({ code: "RELEASE_EXECUTION_SCOPE_MISMATCH" });
    x.workflow.headSha = "c".repeat(40); await expect(x.gate(ctx, "p", x.command)).rejects.toMatchObject({ code: "RELEASE_WORKFLOW_IDENTITY_MISMATCH" }); expect(x.deps.verifyTarget).not.toHaveBeenCalled();
  });
  it("requires registered active execution and a consumed plan", async () => {
    const x = setup(); x.run.stage = "accepted"; await expect(x.gate(ctx, "p", x.command)).rejects.toMatchObject({ code: "RELEASE_EXECUTION_INVALID" });
    x.run.stage = "queued"; x.plan.consumedAt = null; await expect(x.gate(ctx, "p", x.command)).rejects.toMatchObject({ code: "RELEASE_BINDING_CHANGED" });
  });
  it("attests the immutable target before allowing an exact deploy", async () => {
    const x = setup(); expect((await x.gate(ctx, "p", x.command))?.run.id).toBe("r"); expect(x.deps.verifyTarget).toHaveBeenCalledOnce();
    x.deps.verifyTarget.mockRejectedValue(new Error("manifest differs")); await expect(x.gate(ctx, "p", x.command)).rejects.toThrow("manifest differs");
  });
  it("requires complete Compose scope and blocks legacy internal operations", async () => {
    const x = setup(); await expect(x.gate(ctx, "p", { ...x.command, compose: "services: {}", expectedServices: ["app"] })).rejects.toMatchObject({ code: "RELEASE_EXECUTION_SCOPE_MISMATCH" });
    await expect(requireUnmanagedProject("p", x.deps.binding)).rejects.toMatchObject({ code: "GITOPS_RELEASE_REQUIRED" });
    expect(await x.gate(ctx, "p", { ...x.command, compose: "services: {}", expectedServices: ["database", "app"] })).not.toBeNull();
  });
});
