import { expect, it } from "vitest";
import { parseInput, ReleaseTargetSchema } from "../src";

const hash = "a".repeat(64), sha = "b".repeat(40);
const target = { action: "release", workflowSha: sha, manifestCommit: sha, manifestHash: hash, configurationHash: hash,
  releaseId: "core:target", images: {}, ossGitSha: null, services: ["migrate", "platform-api"], eventKey: null, acceptedReceipt: null, manifest: {} };
const migration = { phase: "compatibility-a", policyHash: hash, sourceInventoryHash: hash, inventoryHash: hash,
  deferredMigrations: ["20260815020000_ai_credit_unification_release_b"], pendingMigrations: ["20260930020000_stripe_payment_routes"], databaseContainerId: "db" };
it("retains migration identity across the shared HTTP/SDK contract without accepting undeclared secret fields", () => {
  const parsed = parseInput(ReleaseTargetSchema, { ...target, migration: { ...migration, databaseUrl: "private", providerKey: "private" } });
  expect(parsed.migration).toEqual(migration);
  expect(parsed.migration).not.toHaveProperty("databaseUrl");
  expect(parseInput(ReleaseTargetSchema, target)).not.toHaveProperty("migration");
});
it("rejects unsupported phases and malformed frozen identities", () => {
  for (const invalid of [{ phase: "execute-new-deletion" }, { policyHash: "unknown" }, { databaseContainerId: "" }, { deferredMigrations: ["duplicate", "duplicate"] }])
    expect(() => parseInput(ReleaseTargetSchema, { ...target, migration: { ...migration, ...invalid } })).toThrow();
});
