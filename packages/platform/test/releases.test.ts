import { describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/contracts";
import { createReleaseOperations, releaseHash, releaseStateKind, assertWorkflow, assertReleaseTransition, type ReleaseDependencies, type ReleaseStore } from "../src/releases";
import type { Authorization } from "../src/authorization";
import type { ExecutionContext } from "../src/context";
import type { ReleaseBinding, ReleasePlan, ReleaseRun, ReleaseState } from "@repo/contracts";
const ctx = { userId: "user", organizationId: "org", source: "dashboard", tokenScope: null } as ExecutionContext;
function setup() {
  let now = new Date("2026-10-06T00:00:00Z"), serial = 0;
  const b: ReleaseBinding = { id: "binding", projectId: "p", organizationId: "org", revision: 1, environment: "preview", stack: "admin", repository: "Magic-Resume/Magic-Deploy-Config", manifestPath: "stacks/admin/release.yaml", targetBranch: "deploy/prt", workflowRef: "main", workflows: { preview: "receive-release.yml", production: "promote-production.yml", rollback: "rollback.yml" }, controllerTokenIds: ["controller"], expectedServices: ["admin"], probes: ["https://beta.admin.example.com"] };
  const plans = new Map<string, ReleasePlan>(), runs = new Map<string, ReleaseRun>(); let state: ReleaseState | null = null;
  const store: ReleaseStore = {
    binding: async () => b, bind: async () => b, cache: async () => state, saveState: async s => { state = s; },
    plan: async id => plans.get(id) ?? null, createPlan: async p => { plans.set(p.id, p); }, run: async id => runs.get(id) ?? null,
    byKey: async (p, key) => [...runs.values()].find(r => r.projectId === p && r.idempotencyKey === key) ?? null,
    latest: async () => [...runs.values()].at(-1) ?? null,
    latestStarted: async () => [...runs.values()].filter(r => r.deploymentId).at(-1) ?? null,
    active: async () => [...runs.values()].find(r => r.stage === "submitted") ?? null,
    reserve: async r => { const same = [...runs.values()].find(x => x.idempotencyKey === r.idempotencyKey); if (same) return { run: same, created: false }; runs.set(r.id, r); plans.get(r.planId)!.consumedAt = now.toISOString(); return { run: r, created: true }; },
    updateRun: async (id, patch, expected) => { const row = runs.get(id); if (!row || (expected && row.stage !== expected)) return null; const next = { ...row, ...patch }; runs.set(id, next); return next; }, invalidate: vi.fn(async () => {}),
  };
  const images = { admin: { image: "ghcr.io/example/admin", digest: `sha256:${"a".repeat(64)}`, gitSha: "b".repeat(40) } };
  const fresh = { current: { deploymentId: "dep_old", images, configurationHash: "c", ossGitSha: null, verified: true }, target: { action: "release", workflowSha: "d".repeat(40), manifestCommit: "e".repeat(40), manifestHash: "hash", configurationHash: "c", releaseId: "admin:abc", images, ossGitSha: null, services: ["admin"], eventKey: null, acceptedReceipt: null, manifest: {} }, checks: [{ key: "runtime", label: "runtime", status: "pass" as "pass" | "fail" | "unknown", blocking: true, detail: "verified" }] };
  const workflow = { id: "123", repository: b.repository, workflow: b.workflows.preview, headBranch: "main", headSha: fresh.target.workflowSha, actor: "owner", triggeringActor: "owner", event: "workflow_dispatch", title: "", url: "https://github.com/run", status: "queued", conclusion: null };
  const deps: ReleaseDependencies = { store, now: () => now, id: prefix => `${prefix}_${++serial}`, inspect: vi.fn(async () => structuredClone(fresh)), githubActor: vi.fn(async () => "owner"), dispatch: vi.fn(async () => {}), workflow: vi.fn(async () => workflow), reconcile: vi.fn(async () => null), verifyAcceptance: vi.fn(async () => {}), capabilities: () => ({ runtimeVersion: "test", contractVersion: 1, upstreamCommit: "d".repeat(40), gitops: true, serverEnvironment: true, strictServiceScope: true, durableCutover: false }) };
  const authorization = { authorize: vi.fn(async (c: ExecutionContext) => { if (c.organizationId !== "org") throw new Error("denied"); return c; }) } as unknown as Authorization;
  return { api: createReleaseOperations(authorization, deps), deps, b, fresh, workflow, runs, plans, advance: (ms: number) => { now = new Date(+now + ms); } };
}
const key = { idempotencyKey: "idempotency_12345678" };
describe("GitOps release operations", () => {
  it("backs off failed background reads and keeps their evidence stale", async () => {
    const x = setup();
    vi.mocked(x.deps.inspect).mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 5; i++) expect((await x.api.state(ctx, "p")).data.stale).toBe(true);
    expect(x.deps.inspect).toHaveBeenCalledTimes(1);
    x.advance(60_001);
    await x.api.state(ctx, "p");
    expect(x.deps.inspect).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent reads without sharing another user's inspection", async () => {
    const x = setup();
    await Promise.all(Array.from({ length: 5 }, () => x.api.state(ctx, "p")));
    expect(x.deps.inspect).toHaveBeenCalledTimes(1);
    await x.api.state({ ...ctx, userId: "other" }, "p", { fresh: true });
    expect(x.deps.inspect).toHaveBeenCalledTimes(2);
  });
  it("retains a rate-limit deadline across fresh reads and store restart", async () => {
    const x = setup(), error = Object.assign(new AppError("limited", 503, "RELEASE_SOURCE_RATE_LIMITED"), { retryAt: "2026-10-06T01:00:00.000Z" });
    const first = (await x.api.state(ctx, "p")).data;
    vi.mocked(x.deps.inspect).mockRejectedValue(error);
    const failed = (await x.api.state(ctx, "p", { fresh: true })).data;
    expect(failed.checkedAt).toBe(first.checkedAt);
    expect(failed).toMatchObject({ retryAt: error.retryAt, stale: true, kind: "unknown" });
    const restarted = createReleaseOperations({ authorize: async c => c } as Authorization, x.deps);
    await restarted.state(ctx, "p", { fresh: true });
    expect(x.deps.inspect).toHaveBeenCalledTimes(2);
    x.advance(3_600_001);
    vi.mocked(x.deps.inspect).mockResolvedValue(structuredClone(x.fresh));
    expect((await restarted.state(ctx, "p", { fresh: true })).data.stale).toBe(false);
    expect(x.deps.inspect).toHaveBeenCalledTimes(3);
  });
  it("does not apply another user's persisted rate limit to a fresh read", async () => {
    const x = setup();
    vi.mocked(x.deps.inspect).mockRejectedValue(Object.assign(new AppError("limited",503,"RELEASE_SOURCE_RATE_LIMITED"),{retryAt:"2026-10-06T01:00:00.000Z"}));
    await x.api.state(ctx,"p");
    vi.mocked(x.deps.inspect).mockResolvedValue(structuredClone(x.fresh));
    expect((await x.api.state({...ctx,userId:"other"},"p",{fresh:true})).data.stale).toBe(false);
    expect(x.deps.inspect).toHaveBeenCalledTimes(2);
  });
  it("keeps newer verified evidence when an older concurrent inspection fails", async () => {
    const x = setup();
    await x.api.state(ctx, "p");
    let reject!: (error: Error) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const slow = new Promise<typeof x.fresh>((_, fail) => { reject = fail; });
    vi.mocked(x.deps.inspect).mockImplementation(async context => {
      if (context.userId === ctx.userId) { entered(); return slow; }
      return structuredClone(x.fresh);
    });
    const pending = x.api.state(ctx, "p", { fresh: true });
    await started;
    x.advance(1000); x.fresh.current.deploymentId = "dep_new";
    const latest = (await x.api.state({ ...ctx, userId: "other" }, "p", { fresh: true })).data;
    reject(new Error("offline"));
    const failed = (await pending).data;
    expect(failed.current.deploymentId).toBe("dep_new");
    expect(failed.checkedAt).toBe(latest.checkedAt);
    expect(failed.stale).toBe(true);
  });
  it("compares per-application images and recognizes OSS changes", () => {
    const x = setup(); expect(releaseHash({ b: 2, a: 1 })).toBe(releaseHash({ a: 1, b: 2 }));
    expect(releaseStateKind(x.fresh.current, { ...x.fresh.target, manifestCommit: "f".repeat(40) }, x.fresh.checks)).toBe("current");
    expect(releaseStateKind(x.fresh.current, { ...x.fresh.target, ossGitSha: "f".repeat(40) }, x.fresh.checks)).toBe("available");
  });
  it("duplicate click returns the original run without another dispatch", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data, a = await x.api.start(ctx, p.id, key), b = await x.api.start(ctx, p.id, key);
    expect(b.data.id).toBe(a.data.id); expect(x.deps.dispatch).toHaveBeenCalledOnce();
  });
  it("keeps recovery pending while a live worker drains, then verifies restoration on the next read", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data, r = (await x.api.start(ctx, p.id, key)).data;
    x.workflow.title = `GitOps release ${r.id}`;
    const controller = { ...ctx, tokenScope: { tokenId: "controller" } };
    await x.api.register(controller, r.id, { workflowRunId: "123" });
    x.runs.get(r.id)!.deploymentId = "dep_new";
    x.deps.recover = vi.fn().mockRejectedValueOnce(new AppError("Worker active", 409, "RELEASE_RECOVERY_PENDING")).mockResolvedValue("restored");
    expect((await x.api.progress(controller, r.id, { stage: "recovering", deploymentId: "dep_new" })).data.stage).toBe("recovering");
    expect((await x.api.getRun(ctx, r.id)).data.stage).toBe("restored");
    expect(x.deps.recover).toHaveBeenCalledTimes(2);
  });
  it("rejects expired plans", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data; x.advance(600_000);
    await expect(x.api.start(ctx, p.id, key)).rejects.toMatchObject({ code: "RELEASE_PLAN_EXPIRED" }); expect(x.deps.dispatch).not.toHaveBeenCalled();
  });
  it("rejects a changed incumbent or target", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data; x.fresh.current.deploymentId = "dep_other";
    await expect(x.api.start(ctx, p.id, key)).rejects.toMatchObject({ code: "RELEASE_PLAN_CHANGED" });
  });
  it("an ambiguous submission never redispatches on retry", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data; vi.mocked(x.deps.dispatch).mockRejectedValue(new Error("timeout"));
    const r = (await x.api.start(ctx, p.id, key)).data; expect(r.stage).toBe("dispatch_unknown");
    await x.api.start(ctx, p.id, key); await x.api.getRun(ctx, r.id); expect(x.deps.dispatch).toHaveBeenCalledOnce();
  });
  it("a failed refresh retains last evidence as stale and unknown", async () => {
    const x = setup(), first = (await x.api.state(ctx, "p")).data; vi.mocked(x.deps.inspect).mockRejectedValue(new Error("offline"));
    const result = (await x.api.state(ctx, "p", { fresh: true })).data; expect(result.current).toEqual(first.current); expect(result.kind).toBe("unknown"); expect(result.stale).toBe(true);
  });
  it("a failed refresh reports the current connection failure while preserving the last verified version", async () => {
    const x = setup(), first = (await x.api.state(ctx, "p")).data;
    vi.mocked(x.deps.inspect).mockRejectedValue(new AppError("private credential", 403, "GITHUB_USER_CONNECTION_REQUIRED"));
    const failed = (await x.api.state(ctx, "p", { fresh: true })).data;
    expect(failed.current).toEqual(first.current); expect(failed.checkedAt).toBe(first.checkedAt);
    expect(failed.kind).toBe("unknown"); expect(failed.stale).toBe(true);
    expect(failed.checks[0]).toMatchObject({ key: "inspection.github.connection", status: "unknown", blocking: true });
    expect(failed.error).toContain("GitHub"); expect(JSON.stringify(failed)).not.toContain("private credential");
    vi.mocked(x.deps.inspect).mockResolvedValue(structuredClone(x.fresh));
    const recovered = (await x.api.state(ctx, "p", { fresh: true })).data;
    expect(recovered.kind).toBe("current"); expect(recovered.stale).toBe(false);
    expect(recovered.checks.some(check => check.key.startsWith("inspection."))).toBe(false);
  });
  it("timestamps an inspection before waiting for GitHub or the runtime", async () => {
    const x = setup();
    vi.mocked(x.deps.inspect).mockImplementation(async () => { x.advance(30_000); return structuredClone(x.fresh); });
    expect((await x.api.state(ctx, "p", { fresh: true })).data.checkedAt).toBe("2026-10-06T00:00:00.000Z");
  });
  for (const pollFails of [false, true]) it(`acceptance refreshes cached evidence without losing its outcome when the poll ${pollFails ? "fails" : "succeeds"}`, async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data, r = (await x.api.start(ctx, p.id, key)).data;
    x.workflow.title = `GitOps release ${r.id}`;
    const c = { ...ctx, tokenScope: { tokenId: "controller" } };
    await x.api.register(c, r.id, { workflowRunId: "123" });
    x.deps.afterAcceptance = vi.fn(async () => { x.fresh.current.deploymentId = "dep_new"; });
    x.runs.get(r.id)!.deploymentId = "dep_new";
    await x.api.progress(c, r.id, { stage: "verifying", deploymentId: "dep_new" });
    if (pollFails) vi.mocked(x.deps.inspect).mockRejectedValue(new Error("offline"));
    expect((await x.api.progress(c, r.id, { stage: "accepted", deploymentId: "dep_new" })).data.stage).toBe("accepted");
    expect(x.deps.store.invalidate).toHaveBeenCalledWith("p");
    expect(x.deps.afterAcceptance).toHaveBeenCalledOnce();
    if (!pollFails) expect((await x.deps.store.cache("p"))?.current.deploymentId).toBe("dep_new");
  });
  it("blocks unknown preflight", async () => {
    const x = setup(); x.fresh.checks[0]!.status = "unknown"; const p = (await x.api.plan(ctx, "p")).data;
    await expect(x.api.start(ctx, p.id, key)).rejects.toMatchObject({ code: "RELEASE_PREFLIGHT_BLOCKED" });
  });
  it("requires a bound controller token and exact workflow SHA", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data, r = (await x.api.start(ctx, p.id, key)).data;
    await expect(x.api.register(ctx, r.id, { workflowRunId: "123" })).rejects.toMatchObject({ code: "RELEASE_CONTROLLER_REQUIRED" });
    x.workflow.title = `GitOps release ${r.id}`; x.workflow.headSha = "f".repeat(40);
    await expect(x.api.register({ ...ctx, tokenScope: { tokenId: "controller" } }, r.id, { workflowRunId: "123" })).rejects.toMatchObject({ code: "RELEASE_WORKFLOW_IDENTITY_MISMATCH" });
  });
  it("a consumed queued plan can register after its original expiry", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data, r = (await x.api.start(ctx, p.id, key)).data;
    x.workflow.title = `GitOps release ${r.id}`; x.advance(900_000);
    expect((await x.api.register({ ...ctx, tokenScope: { tokenId: "controller" } }, r.id, { workflowRunId: "123" })).data.stage).toBe("queued");
  });
  it("re-registering a workflow never rewinds an executing release", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data, r = (await x.api.start(ctx, p.id, key)).data;
    x.workflow.title = `GitOps release ${r.id}`; const c = { ...ctx, tokenScope: { tokenId: "controller" } };
    await x.api.register(c, r.id, { workflowRunId: "123" });
    x.runs.get(r.id)!.deploymentId = "dep_new"; // Atomic deployment creation registers ownership
    await x.api.progress(c, r.id, { stage: "verifying", deploymentId: "dep_new" });
    expect((await x.api.register(c, r.id, { workflowRunId: "123" })).data.stage).toBe("verifying");
  });
  it("a concurrent progress change returns an explicit conflict", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data, r = (await x.api.start(ctx, p.id, key)).data;
    x.workflow.title = `GitOps release ${r.id}`; const c = { ...ctx, tokenScope: { tokenId: "controller" } };
    await x.api.register(c, r.id, { workflowRunId: "123" });
    x.deps.store.updateRun = vi.fn(async () => null);
    await expect(x.api.progress(c, r.id, { stage: "deploying" })).rejects.toMatchObject({ code: "RELEASE_STAGE_CONFLICT" });
  });
  it("workflow success alone cannot accept a release", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data, r = (await x.api.start(ctx, p.id, key)).data;
    x.workflow.title = `GitOps release ${r.id}`; const c = { ...ctx, tokenScope: { tokenId: "controller" } };
    await x.api.register(c, r.id, { workflowRunId: "123" }); vi.mocked(x.deps.verifyAcceptance).mockRejectedValue(new Error("probe 503"));
    await expect(x.api.progress(c, r.id, { stage: "accepted" })).rejects.toThrow("probe 503"); expect(x.runs.get(r.id)!.stage).toBe("queued");
  });
  it("production requires confirmation and a human GitHub identity", async () => {
    const x = setup(); x.b.environment = "production"; const p = (await x.api.plan(ctx, "p")).data;
    await expect(x.api.start(ctx, p.id, key)).rejects.toMatchObject({ code: "PRODUCTION_CONFIRMATION_REQUIRED" });
    await expect(x.api.start({ ...ctx, tokenScope: { tokenId: "controller" } }, p.id, { ...key, confirm: "production" })).rejects.toMatchObject({ code: "GITHUB_USER_CONNECTION_REQUIRED" });
  });
  it("rejects cross-org reads, changed rerun operators, and backward progress", async () => {
    const x = setup(), p = (await x.api.plan(ctx, "p")).data; await expect(x.api.getPlan({ ...ctx, organizationId: "other" }, p.id)).rejects.toThrow("denied"); expect(() => assertReleaseTransition("verifying", "deploying")).toThrow();
    const r = (await x.api.start(ctx, p.id, key)).data; x.workflow.title = `GitOps release ${r.id}`; x.workflow.triggeringActor = "other"; expect(() => assertWorkflow(x.b, p, r, x.workflow)).toThrow();
  });
});

 it("rejects a progress update claiming a foreign deployment", async () => {
  const x = setup(), p = (await x.api.plan(ctx, "p")).data, r = (await x.api.start(ctx, p.id, key)).data;
  x.workflow.title = `GitOps release ${r.id}`; const c = { ...ctx, tokenScope: { tokenId: "controller" } };
  await x.api.register(c, r.id, { workflowRunId: "123" });
  await expect(x.api.progress(c, r.id, { stage: "verifying", deploymentId: "foreign" })).rejects.toMatchObject({ code: "RELEASE_DEPLOYMENT_CONFLICT" });
  expect(x.runs.get(r.id)!.deploymentId).toBeNull();
 });
 it("initial binding records unknown runtime without fabricating acceptance", async () => {
  const x = setup(); vi.mocked(x.deps.inspect).mockRejectedValue(new Error("host unreachable"));
  const { id: _id, projectId: _project, organizationId: _org, revision: _revision, ...input } = x.b;
  await x.api.bind(ctx, "p", input);
  const state = await x.deps.store.cache("p");
  expect(state).toMatchObject({ kind: "unknown", stale: true, current: { verified: false } });
  expect(x.runs.size).toBe(0); expect(x.plans.size).toBe(0);
 });
