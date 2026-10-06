import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import { SDK_CAPABILITIES, type ReleasePlan, type ReleaseRun } from "@repo/contracts";

const binding = { id: "binding", projectId: "p/a", organizationId: "org", revision: 1, environment: "preview" as const, stack: "admin", repository: "Magic-Resume/Magic-Deploy-Config", manifestPath: "stacks/admin/release.yaml", targetBranch: "deploy/prt", workflowRef: "main" as const, workflows: { preview: "receive-release.yml", production: "promote-production.yml", rollback: "rollback.yml" }, controllerTokenIds: ["controller"], expectedServices: ["admin"], probes: ["https://beta.admin.example.com"] };
const plan: ReleasePlan = { id: "plan/a", projectId: binding.projectId, organizationId: "org", bindingRevision: 1, current: { deploymentId: "old", images: {}, configurationHash: "a".repeat(64), ossGitSha: null, verified: true }, target: { action: "release", workflowSha: "b".repeat(40), manifestCommit: "c".repeat(40), manifestHash: "d".repeat(64), configurationHash: "e".repeat(64), releaseId: "admin:123456789012", images: {}, ossGitSha: null, services: ["admin"], eventKey: "f".repeat(64), acceptedReceipt: null, manifest: {} }, checks: [], summaryHash: "a".repeat(64), createdAt: "2026-10-07T00:00:00.000Z", expiresAt: "2026-10-07T00:10:00.000Z", consumedAt: null };
const run: ReleaseRun = { id: "run/a", projectId: binding.projectId, organizationId: "org", planId: plan.id, origin: "user", userId: "owner", githubActor: "owner", idempotencyKey: "same_key_123456789", stage: "dispatch_unknown", workflowRunId: null, workflowUrl: null, deploymentId: null, receipt: null, error: null, createdAt: plan.createdAt, updatedAt: plan.createdAt };
function client(result: unknown) {
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { sdk: SDK_CAPABILITIES } : { data: result }));
  return { api: new OpenshipClient({ baseUrl: "https://ship.example.test", token: "fake", organizationId: "org", fetch: fetcher }).releases, fetcher };
}
describe("release SDK contracts", () => {
  it("validates release plans, encodes resource IDs and preserves exact rollback input", async () => {
    const x = client(plan);
    expect(await x.api.plan("p/a", { action: "rollback", manifestCommit: "c".repeat(40) })).toEqual(plan);
    const request = x.fetcher.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(request[0]).toBe("https://ship.example.test/api/projects/p%2Fa/release-plans");
    expect(JSON.parse(request[1].body as string)).toEqual({ action: "rollback", manifestCommit: "c".repeat(40) });
  });
  it("retains the caller's idempotency key and never retries an ambiguous mutation", async () => {
    const x = client(run);
    expect((await x.api.start(plan.id, { idempotencyKey: run.idempotencyKey })).stage).toBe("dispatch_unknown");
    expect(x.fetcher.mock.calls.filter(([url]) => !url.endsWith("/health"))).toHaveLength(1);
    expect(x.fetcher.mock.calls.at(-1)![0]).toBe("https://ship.example.test/api/release-plans/plan%2Fa/runs");
  });
  it("rejects malformed server results and incomplete provenance instead of presenting success", async () => {
    await expect(client({ ...plan, target: { ...plan.target, manifestHash: "not-a-digest" } }).api.getPlan(plan.id)).rejects.toThrow();
    await expect(client({ ...run, stage: "ready" }).api.getRun(run.id)).rejects.toThrow();
    await expect(client({ ...run, origin: "server" }).api.latest(binding.projectId)).rejects.toThrow();
  });
  it("validates binding metadata and represents the absence of a prior run", async () => {
    const { id, projectId, organizationId, revision, ...input } = binding;
    expect(await client(binding).api.bind(binding.projectId, input)).toEqual(binding);
    expect(await client(null).api.latest(binding.projectId)).toBeNull();
  });
  it("does not expose controller registration, automatic execution, or progress", () => {
    const surface = client(null).api;
    expect(Object.keys(surface).sort()).toEqual(["bind", "capabilities", "getPlan", "getRun", "latest", "plan", "start", "state"]);
  });
});
