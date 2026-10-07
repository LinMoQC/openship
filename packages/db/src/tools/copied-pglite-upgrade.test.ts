import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import { createDatabase } from "../connection";
import { verifyCopiedPgliteUpgrade } from "./copied-pglite-upgrade";
import { createEncryption } from "../encryption";
import { createConfigurationSecretsRepo } from "../repos/configuration-secrets.repo";

it("migrates a consistent old disk copy, compares decrypted config and restores the matching old schema without altering the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openship-copied-platform-"));
  const old = join(directory, "old-migrations"), source = join(directory, "source-data"), target = resolve("drizzle");
  try {
    await mkdir(join(old, "meta"), { recursive: true });
    const journal = JSON.parse(await readFile(join(target, "meta/_journal.json"), "utf8"));
    const end = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0122_data_transfer_staging");
    expect(end).toBeGreaterThan(0);
    const entries = journal.entries.slice(0, end + 1);
    for (const entry of entries) await copyFile(join(target, entry.tag + '.sql'), join(old, entry.tag + '.sql'));
    await writeFile(join(old, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    const keyFile = join(directory, "original-key"); await writeFile(keyFile, 'isolated-platform-original-encryption-key', { mode: 0o600 });
    const connection = await createDatabase({ driver: 'pglite', dataDir: source, migrationsDir: old });
    await connection.db.execute(sql`insert into organization(id,name) values ('org','Isolated fixture')`);
    await connection.db.execute(sql`insert into project_app(id,organization_id,name,slug) values ('app','org','Fixture','fixture')`);
    await connection.db.execute(sql`insert into project(id,organization_id,app_id,name,slug) values ('project','org','app','Fixture','fixture')`);
    await connection.db.execute(sql`insert into service(id,project_id,name,environment) values ('service','project','web','{"PASSWORD":"private-old-inline-secret"}'::jsonb)`);
    await connection.close();
    const workspace = join(directory, "workspace");
    const result = await verifyCopiedPgliteUpgrade({ snapshotDataDirectory: source, workspace, keyFile, oldMigrationsDirectory: old, targetMigrationsDirectory: target, assetsDirectory: dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite')) });
    expect(result).toMatchObject({ upgradeVerified: true, wrongKeyRejected: true, matchingRestoreVerified: true, targetRejectedOldSnapshot: true, projects: 1, services: 1, migrations: journal.entries.length });
    expect(JSON.stringify(result)).not.toContain('private-old-inline-secret');
    expect(await readdir(workspace)).toEqual([]);
    const original = await createDatabase({ driver: 'pglite', dataDir: source, migrationsDir: old, migrations: 'verify' });
    try { expect((await original.db.execute(sql`select environment from service where id='service'`)).rows[0]).toMatchObject({ environment: { PASSWORD: 'private-old-inline-secret' } }); }
    finally { await original.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it("verifies an encrypted v0.8 refresh with the same complete migration history and preserves the original disk copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openship-compatible-platform-"));
  const source = join(directory,"source-data"), target = resolve("drizzle"), keyFile = join(directory,"original-key");
  const secret = 'isolated-platform-original-encryption-key';
  const key = createEncryption(secret);
  try {
    await writeFile(keyFile,secret,{mode:0o600});
    const connection = await createDatabase({driver:'pglite',dataDir:source,migrationsDir:target});
    try {
      await connection.db.execute(sql`insert into organization(id,name) values ('org','Isolated fixture')`);
      await connection.db.execute(sql`insert into project_app(id,organization_id,name,slug) values ('app','org','Fixture','fixture')`);
      await connection.db.execute(sql`insert into project(id,organization_id,app_id,name,slug) values ('project','org','app','Fixture','fixture')`);
      await connection.db.execute(sql`insert into service(id,project_id,name,environment) values ('service','project','web','{"PASSWORD":"private-refresh-secret"}'::jsonb)`);
      await createConfigurationSecretsRepo(connection.db,key).backfillLegacy();
    } finally { await connection.close(); }
    const workspace=join(directory,'workspace');
    const result=await verifyCopiedPgliteUpgrade({snapshotDataDirectory:source,workspace,keyFile,oldMigrationsDirectory:target,targetMigrationsDirectory:target,assetsDirectory:dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite'))});
    expect(result).toMatchObject({upgradeVerified:true,wrongKeyRejected:true,matchingRestoreVerified:true,migrationDelta:0,targetRejectedOldSnapshot:false,targetAcceptedCompatibleSnapshot:true,projects:1,services:1});
    expect(JSON.stringify(result)).not.toContain('private-refresh-secret');
    expect(await readdir(workspace)).toEqual([]);
    const original=await createDatabase({driver:'pglite',dataDir:source,migrationsDir:target,migrations:'verify'});
    try { await createConfigurationSecretsRepo(original.db,key).assertReadable(); }
    finally { await original.close(); }
  } finally { key.close(); await rm(directory,{recursive:true,force:true}); }
},60_000);
