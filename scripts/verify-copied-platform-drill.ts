import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDatabase } from "../packages/db/src/connection";
import { createEncryption } from "../packages/db/src/encryption";
import { createConfigurationSecretsRepo } from "../packages/db/src/repos/configuration-secrets.repo";

// Invoked against the extracted CLI artifact before publication. The fixture
// uses old schema/data, never a live DB or business credentials. The program
// under test and its WASM/migrations come only from the packaged distribution.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("An extracted target runtime is required");
const runtimeDirectory = resolve(process.argv[2]);
const { runCopiedPlatformDrill } = await import(pathToFileURL(join(runtimeDirectory, "dist/server/copied-platform-docker.mjs")).href);
const directory = await realpath(await mkdtemp(join(tmpdir(), "openship-package-copy-drill-")));
try {
  const old = join(directory, "old-migrations"), source = join(directory, "data");
  await mkdir(join(old, "meta"), { recursive: true });
  const migrations = join(root, "packages/db/drizzle"), journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
  const end = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0122_data_transfer_staging");
  if (end < 0) throw new Error("Retained old migration boundary is missing");
  const entries = journal.entries.slice(0, end + 1);
  for (const entry of entries) await copyFile(join(migrations, entry.tag + ".sql"), join(old, entry.tag + ".sql"));
  await writeFile(join(old, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  const keyFile = join(directory, "key");
  await writeFile(keyFile, "isolated-original-package-drill-key", { mode: 0o600 });
  const connection = await createDatabase({ driver: "pglite", dataDir: source, migrationsDir: old });
  try {
    await connection.db.execute(sql`insert into organization(id,name) values ('org','Isolated fixture')`);
    await connection.db.execute(sql`insert into project_app(id,organization_id,name,slug) values ('app','org','Fixture','fixture')`);
    await connection.db.execute(sql`insert into project(id,organization_id,app_id,name,slug) values ('project','org','app','Fixture','fixture')`);
    await connection.db.execute(sql`insert into service(id,project_id,name,environment) values ('service','project','web','{"PASSWORD":"private-test-only"}'::jsonb)`);
  } finally { await connection.close(); }
  const result = await runCopiedPlatformDrill({ dataDirectory: source, keyFile, runtimeDirectory, oldMigrationsDirectory: old, dockerHost: process.env.DOCKER_HOST });
  const original = await createDatabase({ driver: "pglite", dataDir: source, migrationsDir: old, migrations: "verify" });
  try {
    if (JSON.stringify((await original.db.execute(sql`select environment from service where id='service'`)).rows[0]) !== JSON.stringify({ environment: { PASSWORD: "private-test-only" } })) throw new Error("The read-only source snapshot changed");
  } finally { await original.close(); }
  // A later v0.8 package can have the same schema. Exercise that shipped path
  // too; compatible refreshes still prove encryption, restore and source identity.
  const encryption = createEncryption((await readFile(keyFile,"utf8")).trim());
  let ciphertext;
  const current = await createDatabase({driver:'pglite',dataDir:source,migrationsDir:migrations});
  try {
    await createConfigurationSecretsRepo(current.db,encryption).backfillLegacy();
    ciphertext=JSON.stringify((await current.db.execute(sql`select environment from service where id='service'`)).rows);
  } finally { await current.close(); encryption.close(); }
  const compatible=await runCopiedPlatformDrill({dataDirectory:source,keyFile,runtimeDirectory,oldMigrationsDirectory:migrations,dockerHost:process.env.DOCKER_HOST});
  if (compatible.migrationDelta !== 0 || compatible.targetAcceptedCompatibleSnapshot !== true || compatible.targetRejectedOldSnapshot !== false) throw new Error('Packaged compatible refresh did not verify the unchanged schema');
  const unchanged=await createDatabase({driver:'pglite',dataDir:source,migrationsDir:migrations,migrations:'verify'});
  try { if (JSON.stringify((await unchanged.db.execute(sql`select environment from service where id='service'`)).rows) !== ciphertext) throw new Error('Compatible refresh altered its source snapshot'); }
  finally { await unchanged.close(); }
  console.log(JSON.stringify({ packagedCopiedDatabaseDrill: result, packagedCompatibleRefreshDrill:compatible, sourceUnchanged: true }));
} finally { await rm(directory, { recursive: true, force: true }); }
