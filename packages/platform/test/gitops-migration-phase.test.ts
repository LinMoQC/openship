import { describe, expect, it } from "vitest";
import { migrationExecutionInventory, migrationInputsChanged, migrationEvidenceMatches, migrationExecutionMatches } from "../src/gitops-migrations";

const deferred = "20260815020000_ai_credit_unification_release_b";
const target = ["20260801000000_init", deferred, "20260930020000_stripe_payment_routes"].map(name => ({ name, blobSha: "b".repeat(40), checksum: "c".repeat(64) }));
const applied = [{ ...target[0]!, failed: false }];
const policy = { schemaVersion: 1, migrationSource: "a".repeat(40), newReleaseBExecutionSupported: false,
  deferredMigration: { name: deferred, checksum: "c".repeat(64) }, migrations: target.map(({ name, checksum }) => ({ name, checksum })) };

describe("immutable migration execution phase", () => {
  it("keeps the deletion honestly deferred while still requiring the Stripe migration", () => {
    const x = migrationExecutionInventory(target, applied, policy);
    expect(x.phase).toBe("compatibility-a");
    expect(x.delta.pending).toEqual(["20260930020000_stripe_payment_routes"]);
    expect(x.deferredMigrations).toEqual([deferred]);
    expect(x.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(x.sourceInventoryHash).not.toBe(x.delta.inventoryHash);
  });
  it("requires the migration job when execution policy changes without SQL changes", () => {
    for (const filename of ["packages/db/runtime/deploy-migrations.mjs", "packages/db/runtime/migration-compatibility-policy.json", "packages/db/prisma.config.ts", "packages/db/package.json"])
      expect(migrationInputsChanged([{ filename }])).toBe(true);
    expect(migrationInputsChanged([{ filename: "apps/platform-api/src/main.ts" }])).toBe(false);
  });
  it("recognizes genuinely completed B without pretending a failed or modified B was accepted", () => {
    const completed = migrationExecutionInventory(target, [...applied, { ...target[1]!, failed: false }], policy);
    expect(completed.phase).toBe("complete");
    expect(completed.deferredMigrations).toEqual([]);
    expect(completed.sourceInventoryHash).toBe(completed.delta.inventoryHash);
    const failed = migrationExecutionInventory(target, [...applied, { ...target[1]!, failed: true }], policy);
    expect(failed.delta.failed).toEqual([deferred]);
    const modified = migrationExecutionInventory(target, [...applied, { ...target[1]!, checksum: "d".repeat(64), failed: false }], policy);
    expect(modified.delta.modified).toEqual([deferred]);
    expect(migrationExecutionInventory(target, [...applied, { name: "unknown", checksum: "c".repeat(64), failed: false }], policy).delta.unexpected).toEqual(["unknown"]);
    expect(() => migrationExecutionInventory(target, [...applied, ...applied], policy)).toThrow(/duplicate active/);
  });
  it("fails closed on malformed policies, changed SQL, hidden migrations or a new deletion capability", () => {
    for (const bad of [undefined, {}, { ...policy, schemaVersion: 2 }, { ...policy, newReleaseBExecutionSupported: true },
      { ...policy, deferredMigration: { ...policy.deferredMigration, name: target[2]!.name } },
      { ...policy, migrations: policy.migrations.slice(1) },
      { ...policy, migrations: [policy.migrations[0], policy.migrations[0], policy.migrations[2]] },
      { ...policy, migrations: policy.migrations.map(row => ({ ...row, checksum: "d".repeat(64) })) }])
      expect(() => migrationExecutionInventory(target, applied, bad)).toThrow(/immutable SQL inventory/);
    const legacy = migrationExecutionInventory(target, applied, null);
    expect(legacy.phase).toBe("source");
    expect(legacy.delta.pending).toContain(deferred);
  });
  it("requires drill evidence for the exact execution phase as well as the image and SQL inventory", () => {
    const execution = migrationExecutionInventory(target, applied, policy), delta = execution.delta;
    const expected = { gitSha: "a".repeat(40), digest: "sha256:" + "b".repeat(64), environment: "production", deploymentId: "dep", databaseContainerId: "db", execution };
    const evidence = { ...expected, imageDigest: expected.digest, sourceDeploymentId: "dep", inventoryHash: delta.inventoryHash, pendingMigrations: delta.pending,
      backup: { status: "verified", sha256: "f".repeat(64), createdAt: new Date().toISOString() }, restore: { status: "verified", isolated: true, backupSha256: "f".repeat(64) },
      migration: { status: "verified", imageDigest: expected.digest, inventoryHash: delta.inventoryHash, phase: execution.phase, policyHash: execution.policyHash, sourceInventoryHash: execution.sourceInventoryHash, deferredMigrations: execution.deferredMigrations } };
    expect(migrationEvidenceMatches(evidence, expected, delta)).toBe(true);
    for (const changes of [{ phase: "complete" }, { policyHash: "c".repeat(64) }, { sourceInventoryHash: "c".repeat(64) }, { deferredMigrations: [] }])
      expect(migrationEvidenceMatches({ ...evidence, migration: { ...evidence.migration, ...changes } }, expected, delta)).toBe(false);
    expect(migrationEvidenceMatches({ ...evidence, pendingMigrations: [deferred, ...delta.pending] }, expected, delta)).toBe(false);
  });
  it("rechecks frozen execution identity after the migrate job without demanding that applied SQL become pending again", () => {
    const before = migrationExecutionInventory(target, applied, policy);
    const expected = { ...before, inventoryHash: before.delta.inventoryHash };
    const after = migrationExecutionInventory(target, [...applied, { ...target[2]!, failed: false }], policy);
    expect(after.delta.pending).toEqual([]);
    expect(migrationExecutionMatches(expected, after)).toBe(true);
    for (const change of [{ phase: "complete" }, { policyHash: "d".repeat(64) }, { sourceInventoryHash: "d".repeat(64) }, { inventoryHash: "d".repeat(64) }, { deferredMigrations: [] }])
      expect(migrationExecutionMatches({ ...expected, ...change }, after)).toBe(false);
    for (const history of [
      [...applied, { ...target[2]!, failed: true }],
      [...applied, { ...target[2]!, checksum: "d".repeat(64), failed: false }],
      [...applied, { name: "unknown", checksum: "d".repeat(64), failed: false }],
      [...applied, { ...target[1]!, failed: false }],
    ]) expect(migrationExecutionMatches(expected, migrationExecutionInventory(target, history, policy))).toBe(false);
  });
});
