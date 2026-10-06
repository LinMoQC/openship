import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "../factory";
import { createEncryption } from "../encryption";

describe("release admission and cutover ownership in real SQL", () => {
  let connection: DatabaseConnection;
  let repos: ReturnType<typeof createRepositories>;
  const encryption = createEncryption("isolated-release-test-key");
  let sequence = 0;
  beforeAll(async () => {
    connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
    repos = createRepositories(connection.db, encryption);
    await connection.db.insert(schema.organization).values({ id: "org", name: "Test" });
  });
  afterAll(async () => { await connection?.close(); encryption.close(); });
  async function fixture() {
    const id = `project-${++sequence}`, now = new Date();
    const group = await repos.projectGroup.create({ organizationId: "org", name: id, slug: id });
    const project = await repos.project.create({ groupId: group.id, organizationId: "org", name: id, slug: id });
    const plan = await repos.releases.createPlan({ id: `plan-${sequence}`, projectId: project.id, organizationId: "org", bindingRevision: 1, snapshot: {}, summaryHash: "a".repeat(64), expiresAt: new Date(+now + 600_000) });
    const run = { id: `run-${sequence}`, projectId: project.id, organizationId: "org", planId: plan.id, userId: "owner", githubActor: "owner", origin: "user", idempotencyKey: `key_${sequence}_123456789`, stage: "queued", workflowRunId: "123" };
    return { now, project, plan, run };
  }
  it("simultaneous identical submissions reserve one Run and consume one plan", async () => {
    const f = await fixture();
    const results = await Promise.all([repos.releases.reserve(f.run, f.now), repos.releases.reserve({ ...f.run, id: `${f.run.id}-other` }, f.now)]);
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.row.id)).size).toBe(1);
    expect((await repos.releases.plan(f.plan.id))!.consumedAt).not.toBeNull();
  });
  it("different plans cannot execute at the same project simultaneously", async () => {
    const f = await fixture(); await repos.releases.reserve(f.run, f.now);
    const second = await repos.releases.createPlan({ ...f.plan, id: `${f.plan.id}-second`, consumedAt: null });
    await expect(repos.releases.reserve({ ...f.run, id: `${f.run.id}-second`, planId: second.id, idempotencyKey: "another_key_12345678" }, f.now)).rejects.toThrow("RELEASE_IN_PROGRESS");
    await repos.releases.updateRun(f.run.id, { stage: "failed" }, "queued");
    expect((await repos.releases.reserve({ ...f.run, id: `${f.run.id}-second`, planId: second.id, idempotencyKey: "another_key_12345678" }, f.now)).created).toBe(true);
  });
  it("expired plans cannot admit a workflow", async () => {
    const f = await fixture();
    await expect(repos.releases.reserve(f.run, new Date(+f.plan.expiresAt + 1))).rejects.toThrow("RELEASE_PLAN_EXPIRED");
    expect(await repos.releases.run(f.run.id)).toBeUndefined();
  });
  it("deployment, Run association and worker lease are atomic and lost responses never create a second deployment", async () => {
    const f = await fixture(); await repos.releases.reserve(f.run, f.now);
    const input = { projectId: f.project.id, organizationId: "org", branch: "deploy/prt", environment: "preview", commitSha: "a".repeat(40), meta: { releaseRunId: f.run.id }, status: "queued" };
    const first = await repos.deployment.create(input), second = await repos.deployment.create(input);
    expect(first!.id).toBe(second!.id);
    expect((await repos.releases.run(f.run.id))!.deploymentId).toBe(first!.id);
    expect(await repos.deployment.findBuildSessionByDeploymentId(first!.id)).toBeTruthy();
    await repos.deployment.updateStatus(first!.id, "ready");
    expect((await repos.deployment.create(input))!.id).toBe(first!.id);
    await expect(repos.deployment.create({ ...input, commitSha: "b".repeat(40) })).rejects.toThrow("RELEASE_DEPLOYMENT_CONFLICT");
  });
  it("a foreign journal ID cannot overwrite an existing service cutover", async () => {
    const f = await fixture();
    const record = { id: "journal-a", projectId: f.project.id, deploymentId: "dep-test", serviceName: "web", stage: "prepared", imageId: "sha256:old", incumbentId: "old-container", context: {} };
    await repos.releases.journal(record);
    expect(await repos.releases.journal({ ...record, id: "journal-b", incumbentId: "foreign-container" })).toBeUndefined();
    expect((await repos.releases.journals(f.project.id))[0]!.incumbentId).toBe("old-container");
  });
  it("a rebound project rejects an old binding's late inspection", async () => {
    const f = await fixture(), input = { id: `binding-${sequence}`, projectId: f.project.id, organizationId: "org", config: {} };
    const old = await repos.releases.bind(input);
    const current = await repos.releases.bind(input);
    await repos.releases.cache(f.project.id, { evidence: "old binding" }, new Date(Date.now() + 10), old.revision);
    expect((await repos.releases.binding(f.project.id))!.lastState).toBeNull();
    await repos.releases.cache(f.project.id, { evidence: "current binding" }, new Date(Date.now() + 20), current.revision);
    expect((await repos.releases.binding(f.project.id))!.lastState).toEqual({ evidence: "current binding" });
  });
  it("invalidation prevents an in-flight inspection from repopulating stale evidence", async () => {
    const f = await fixture();
    const binding = await repos.releases.bind({ id: `binding-${sequence}`, projectId: f.project.id, organizationId: "org", config: {} });
    const inspectionStarted = binding.updatedAt;
    await repos.releases.cache(f.project.id, { evidence: "before deploy" }, inspectionStarted, binding.revision);
    await repos.releases.invalidate(f.project.id);
    await repos.releases.cache(f.project.id, { evidence: "late old poll" }, inspectionStarted, binding.revision);
    const stale = (await repos.releases.binding(f.project.id))!;
    expect(stale.checkedAt).toBeNull(); expect(stale.lastState).toEqual({ evidence: "before deploy" });
    const freshStarted = new Date(+stale.updatedAt + 1);
    await repos.releases.cache(f.project.id, { evidence: "accepted deploy" }, freshStarted, binding.revision);
    await repos.releases.cache(f.project.id, { evidence: "older poll" }, inspectionStarted, binding.revision);
    expect((await repos.releases.binding(f.project.id))!.lastState).toEqual({ evidence: "accepted deploy" });
  });
});
