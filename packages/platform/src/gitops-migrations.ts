import { AppError } from "@repo/contracts";
import { releaseHash } from "./releases";
export interface AppliedMigration { name: string; checksum: string; failed: boolean; }
export interface TargetMigration { name: string; blobSha: string; checksum: string; }
/** Compare the actual Prisma ledger against the immutable target's migration tree. */
export function migrationDelta(target: TargetMigration[], applied: AppliedMigration[]) {
  const names = new Set(target.map(m => m.name));
  if (names.size !== target.length || target.some(m => !/^[A-Za-z0-9_]+$/.test(m.name) || !/^[a-f0-9]{40}$/.test(m.blobSha) || !/^[a-f0-9]{64}$/.test(m.checksum))) throw new AppError("Invalid target migration inventory", 409, "RELEASE_MIGRATION_TARGET_INVALID");
  const failed = applied.filter(m => m.failed).map(m => m.name).sort();
  const unexpected = applied.filter(m => !names.has(m.name) && !m.failed).map(m => m.name).sort();
  const completed = new Set(applied.filter(m => !m.failed).map(m => m.name));
  const modified = [...new Set(applied.filter(m => !m.failed && names.has(m.name) && m.checksum !== target.find(t => t.name === m.name)!.checksum).map(m => m.name))].sort();
  const pending = target.filter(m => !completed.has(m.name)).map(m => m.name).sort();
  return { pending, failed, unexpected, modified, inventoryHash: releaseHash([...target].sort((a, b) => a.name.localeCompare(b.name))) };
}
type ObjectRecord = Record<string, unknown>;
const record = (value: unknown): ObjectRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectRecord : {};
/** Select the target image's migration phase without changing any SQL/ledger. */
export function migrationExecutionInventory(target: TargetMigration[], applied: AppliedMigration[], policy: unknown) {
  const source = migrationDelta(target, applied);
  if (policy === null) return { phase: "source" as const, policyHash: null,
    sourceInventoryHash: source.inventoryHash, deferredMigrations: [] as string[], delta: source };
  const p = record(policy), deferred = record(p.deferredMigration), deletion = "20260815020000_ai_credit_unification_release_b";
  const rows = Array.isArray(p.migrations) ? p.migrations.map(record) : [];
  if (p.schemaVersion !== 1 || p.newReleaseBExecutionSupported !== false ||
    typeof p.migrationSource !== "string" || !/^[a-f0-9]{40}$/.test(p.migrationSource) || deferred.name !== deletion ||
    rows.length !== target.length || new Set(rows.map(row => row.name)).size !== rows.length ||
    rows.some(row => !target.some(t => t.name === row.name && t.checksum === row.checksum)) ||
    !target.some(t => t.name === deletion && t.checksum === deferred.checksum))
    throw new AppError("Migration policy does not match the immutable SQL inventory", 409, "RELEASE_MIGRATION_POLICY_INVALID");
  if (new Set(applied.map(row => row.name)).size !== applied.length)
    throw new AppError("Migration ledger contains duplicate active entries", 409, "RELEASE_MIGRATION_LEDGER_INVALID");
  const completed = applied.some(row => row.name === deletion && !row.failed && row.checksum === deferred.checksum);
  const effective = completed ? source : migrationDelta(target.filter(row => row.name !== deletion), applied);
  return { phase: completed ? "complete" as const : "compatibility-a" as const,
    policyHash: releaseHash(p), sourceInventoryHash: source.inventoryHash, deferredMigrations: completed ? [] : [deletion],
    // Never hide a failed/modified deletion or unknown ledger row by excluding
    // it from the execution directory. Only the pending list is phase-specific.
    delta: { ...effective, failed: source.failed, unexpected: source.unexpected, modified: source.modified } };
}
export function migrationInputsChanged(files: Array<{ filename: string }>) {
  return files.some(file => file.filename.startsWith("packages/db/prisma/migrations/") ||
    file.filename.startsWith("packages/db/runtime/") || ["packages/db/prisma.config.ts", "packages/db/package.json"].includes(file.filename));
}
export function migrationExecutionMatches(expected: { phase: string; policyHash: string | null; sourceInventoryHash: string; inventoryHash: string; deferredMigrations: string[] }, actual: ReturnType<typeof migrationExecutionInventory>) {
  return expected.phase === actual.phase && expected.policyHash === actual.policyHash && expected.sourceInventoryHash === actual.sourceInventoryHash &&
    expected.inventoryHash === actual.delta.inventoryHash && releaseHash(expected.deferredMigrations) === releaseHash(actual.deferredMigrations) &&
    !actual.delta.failed.length && !actual.delta.modified.length && !actual.delta.unexpected.length;
}
export function migrationEvidenceMatches(value: unknown, target: { gitSha: string; digest: string; environment: string; deploymentId: string; databaseContainerId: string; execution?: ReturnType<typeof migrationExecutionInventory> }, delta: ReturnType<typeof migrationDelta>, now = Date.now()) {
  const e = record(value), backup = record(e.backup), restore = record(e.restore), migration = record(e.migration);
  const backedUpAt = typeof backup.createdAt === "string" ? Date.parse(backup.createdAt) : NaN;
  return e.gitSha === target.gitSha && e.imageDigest === target.digest && e.environment === target.environment &&
    e.sourceDeploymentId === target.deploymentId && e.databaseContainerId === target.databaseContainerId &&
    e.inventoryHash === delta.inventoryHash && Array.isArray(e.pendingMigrations) && releaseHash(e.pendingMigrations) === releaseHash(delta.pending) &&
    !delta.failed.length && !delta.unexpected.length && !delta.modified.length &&
    backup.status === "verified" && typeof backup.sha256 === "string" && /^[a-f0-9]{64}$/.test(backup.sha256) &&
    backedUpAt <= now && now - backedUpAt <= 24 * 60 * 60 * 1000 &&
    restore.status === "verified" && restore.isolated === true && restore.backupSha256 === backup.sha256 &&
    migration.status === "verified" && migration.imageDigest === target.digest && migration.inventoryHash === delta.inventoryHash &&
    (!target.execution?.policyHash || (migration.phase === target.execution.phase && migration.policyHash === target.execution.policyHash &&
      migration.sourceInventoryHash === target.execution.sourceInventoryHash && Array.isArray(migration.deferredMigrations) && releaseHash(migration.deferredMigrations) === releaseHash(target.execution.deferredMigrations)));
}
