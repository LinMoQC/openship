import { sql } from "drizzle-orm";

/**
 * Magic runtimes before v0.9 recorded the GitOps release tables as
 * `0151_gitops_releases`, stamped 2026-10-05. Upstream later shipped its own
 * 0151…0223 with earlier timestamps. Drizzle applies only migrations newer
 * than the latest ledger row, so leaving that row in place would silently skip
 * fifteen upstream migrations. The release tables now live in the idempotent
 * `0224_gitops_releases`; removing the legacy row lets the ledger resume after
 * upstream 0150 and converge.
 */
export const LEGACY_GITOPS_MIGRATION = {
  createdAt: 1791223200000,
  hash: "504c32a406469b47ef69d2a12d38bd026cdd7cdda12bc669c66a03f3e074155d",
} as const;

type Executor = { execute(query: ReturnType<typeof sql>): Promise<{ rows: unknown[] }> };

/**
 * Remove the exact legacy ledger row, if present. A row at the legacy
 * timestamp with any other hash is an unknown history: refuse to migrate
 * rather than guess which upstream migrations it stands in for.
 */
export async function bridgeLegacyGitopsMigration(db: Executor): Promise<boolean> {
  const ledger = await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  if ((ledger.rows[0] as { present?: boolean } | undefined)?.present !== true) return false;
  const rows = (await db.execute(
    sql`select hash from drizzle.__drizzle_migrations where created_at = ${LEGACY_GITOPS_MIGRATION.createdAt}`,
  )).rows as { hash: string }[];
  if (!rows.length) return false;
  if (rows.some(row => row.hash !== LEGACY_GITOPS_MIGRATION.hash))
    throw new Error("The database migration history contains an unknown entry at the legacy GitOps release timestamp. Restore a verified backup or migrate it manually.");
  await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${LEGACY_GITOPS_MIGRATION.createdAt} and hash = ${LEGACY_GITOPS_MIGRATION.hash}`);
  return true;
}
