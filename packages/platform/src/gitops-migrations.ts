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
export function migrationEvidenceMatches(value: unknown, target: { gitSha: string; digest: string; environment: string; deploymentId: string; databaseContainerId: string }, delta: ReturnType<typeof migrationDelta>, now = Date.now()) {
  const e = record(value), backup = record(e.backup), restore = record(e.restore), migration = record(e.migration);
  const backedUpAt = typeof backup.createdAt === "string" ? Date.parse(backup.createdAt) : NaN;
  return e.gitSha === target.gitSha && e.imageDigest === target.digest && e.environment === target.environment &&
    e.sourceDeploymentId === target.deploymentId && e.databaseContainerId === target.databaseContainerId &&
    e.inventoryHash === delta.inventoryHash && Array.isArray(e.pendingMigrations) && releaseHash(e.pendingMigrations) === releaseHash(delta.pending) &&
    !delta.failed.length && !delta.unexpected.length && !delta.modified.length &&
    backup.status === "verified" && typeof backup.sha256 === "string" && /^[a-f0-9]{64}$/.test(backup.sha256) &&
    backedUpAt <= now && now - backedUpAt <= 24 * 60 * 60 * 1000 &&
    restore.status === "verified" && restore.isolated === true && restore.backupSha256 === backup.sha256 &&
    migration.status === "verified" && migration.imageDigest === target.digest && migration.inventoryHash === delta.inventoryHash;
}
