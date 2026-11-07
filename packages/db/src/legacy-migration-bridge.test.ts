import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { LEGACY_GITOPS_MIGRATION, bridgeLegacyGitopsMigration } from "./legacy-migration-bridge";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};
const current = readFileSync(join(MIGRATIONS_DIR, "0224_gitops_releases.sql"), "utf8");
// The legacy file is the current one without its header and idempotency guards.
const legacySql = current.split("\n").slice(2).join("\n").replaceAll(" IF NOT EXISTS", "");
const temporary: string[] = [];

/** The ledger and files a pre-v0.9 Magic runtime shipped: upstream 0000-0150 plus 0151_gitops_releases. */
function legacyMigrations(sqlText = legacySql): string {
  const dir = mkdtempSync(join(tmpdir(), "osh-legacy-gitops-"));
  temporary.push(dir);
  mkdirSync(join(dir, "meta"));
  const upstream = journal.entries.filter(entry => entry.idx <= 150);
  for (const entry of upstream) copyFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(join(dir, "0151_gitops_releases.sql"), sqlText);
  const entries = [...upstream, { idx: 151, version: "7", when: LEGACY_GITOPS_MIGRATION.createdAt, tag: "0151_gitops_releases", breakpoints: true }];
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2));
  return dir;
}

async function schemaShape(db: ReturnType<typeof drizzle>) {
  const columns = await db.execute(sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const indexes = await db.execute(sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`);
  return { columns: columns.rows, indexes: indexes.rows };
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("legacy GitOps migration bridge", () => {
  test("the legacy file hash is the one recorded by earlier runtimes", () => {
    expect(createHash("sha256").update(legacySql).digest("hex")).toBe(LEGACY_GITOPS_MIGRATION.hash);
  });

  test("an upgraded legacy database applies every upstream migration and matches a fresh install", async () => {
    const legacyClient = new PGlite("memory://");
    const upgraded = drizzle(legacyClient);
    await migrate(upgraded, { migrationsFolder: legacyMigrations() });
    await expect(bridgeLegacyGitopsMigration(upgraded)).resolves.toBe(true);
    await migrate(upgraded, { migrationsFolder: MIGRATIONS_DIR });
    await expect(bridgeLegacyGitopsMigration(upgraded)).resolves.toBe(false);

    const ledger = (await upgraded.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`)).rows
      .map(row => Number((row as { created_at: unknown }).created_at));
    expect(ledger).toEqual(journal.entries.map(entry => entry.when).sort((a, b) => a - b));

    const freshClient = new PGlite("memory://");
    const fresh = drizzle(freshClient);
    await expect(bridgeLegacyGitopsMigration(fresh)).resolves.toBe(false);
    await migrate(fresh, { migrationsFolder: MIGRATIONS_DIR });
    expect(await schemaShape(upgraded)).toEqual(await schemaShape(fresh));
    await legacyClient.close();
    await freshClient.close();
  }, 120_000);

  test("refuses an unknown history at the legacy timestamp", async () => {
    const client = new PGlite("memory://");
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: legacyMigrations(`${legacySql}\n-- altered\n`) });
    await expect(bridgeLegacyGitopsMigration(db)).rejects.toThrow("unknown entry");
    await client.close();
  }, 120_000);
});
