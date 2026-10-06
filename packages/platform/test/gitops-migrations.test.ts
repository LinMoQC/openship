import { describe, expect, it } from "vitest";
import { migrationDelta, migrationEvidenceMatches } from "../src/gitops-migrations";
const target = ['001_init', '002_add', '003_index'].map(name => ({ name, blobSha: 'a'.repeat(40), checksum: 'c'.repeat(64) }));
describe('actual migration delta', () => {
  it('counts pending migrations from the real ledger and flags failed or unknown history', () => {
    const x = migrationDelta(target, [{ name: '001_init', checksum: 'c'.repeat(64), failed: false }, { name: '002_add', checksum: 'c'.repeat(64), failed: true }, { name: 'unknown', checksum: 'c'.repeat(64), failed: false }]);
    expect(x.pending).toEqual(['002_add', '003_index']); expect(x.failed).toEqual(['002_add']); expect(x.unexpected).toEqual(['unknown']);
  });
  it('blocks a previously applied migration whose SQL contents were changed', () => {
    const delta = migrationDelta(target, [{ name: '001_init', checksum: 'f'.repeat(64), failed: false }]);
    expect(delta.modified).toEqual(['001_init']);
  });
  it('requires recovery evidence for the precise image, database, environment and migration inventory', () => {
    const delta = migrationDelta(target, []), expected = { gitSha: 'b'.repeat(40), digest: 'sha256:'+'c'.repeat(64), environment: 'preview', deploymentId: 'dep', databaseContainerId: 'db' };
    const evidence = { ...expected, imageDigest: expected.digest, sourceDeploymentId: expected.deploymentId, inventoryHash: delta.inventoryHash, pendingMigrations: delta.pending, backup: { status: 'verified', sha256: 'd'.repeat(64), createdAt: new Date().toISOString() }, restore: { status: 'verified', isolated: true, backupSha256: 'd'.repeat(64) }, migration: { status: 'verified', imageDigest: expected.digest, inventoryHash: delta.inventoryHash } };
    expect(migrationEvidenceMatches(evidence, expected, delta)).toBe(true);
    expect(migrationEvidenceMatches({ ...evidence, environment: 'production' }, expected, delta)).toBe(false);
    expect(migrationEvidenceMatches({ ...evidence, pendingMigrations: ['001_init'] }, expected, delta)).toBe(false);
    expect(migrationEvidenceMatches({ ...evidence, backup: { ...evidence.backup, createdAt: '2000-01-01T00:00:00Z' } }, expected, delta)).toBe(false);
    expect(migrationEvidenceMatches({ ...evidence, restore: { ...evidence.restore, backupSha256: 'e'.repeat(64) } }, expected, delta)).toBe(false);
    expect(migrationEvidenceMatches(null, expected, delta)).toBe(false);
  });
});
