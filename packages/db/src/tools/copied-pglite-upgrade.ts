import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../connection";
import { createEncryption } from "../encryption";
import { createConfigurationSecrets, SERVICE_SECRET_FIELDS } from "../configuration-secrets";
import { createConfigurationSecretsRepo } from "../repos/configuration-secrets.repo";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)])) : value;
const checksum = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
interface Input {
  snapshotDataDirectory: string; workspace: string; keyFile: string;
  oldMigrationsDirectory: string; targetMigrationsDirectory: string; assetsDirectory: string;
}
/** No Platform, providers, worker, HTTP client or job runner is imported here.
 * The caller additionally isolates this process from networks and host sockets.
 * Configuration plaintext is compared in memory and never written to evidence. */
export async function verifyCopiedPgliteUpgrade(input: Input) {
  const key = createEncryption((await readFile(input.keyFile, "utf8")).trim());
  const codec = createConfigurationSecrets(key);
  const camel = (field: string) => field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  async function snapshot(db: Database, fields?: string[]) {
    const columns = (await db.execute(sql`select column_name from information_schema.columns where table_schema='public' and table_name='service' order by column_name`)).rows.map(row => camel(String(row.column_name)));
    const compared = fields ?? SERVICE_SECRET_FIELDS.filter(field => columns.includes(field));
    const services = (await db.execute(sql`select to_jsonb(service) as row from service order by id`)).rows.map(row => {
      const stored = Object.fromEntries(Object.entries(row.row as Record<string, unknown>).map(([k,v]) => [camel(k),v]));
      const plain = codec.openService(stored);
      return { id: plain.id, ...Object.fromEntries(compared.map(field => [field, plain[field]])) };
    });
    const deployments = (await db.execute(sql`select id, meta from deployment order by id`)).rows.map(row => codec.openDeployment(row));
    const environments = (await db.execute(sql`select id, value from env_var order by id`)).rows.map(row => ({ id: row.id, value: key.decrypt(String(row.value)) }));
    const projects = (await db.execute(sql`select id, active_deployment_id from project order by id`)).rows;
    const users = (await db.execute(sql`select id from "user" order by id`)).rows;
    return { fields: compared, fingerprint: checksum({ services, deployments, environments, projects, users }), projects: projects.length, users: users.length, services: services.length, deployments: deployments.length };
  }
  const workspace = resolve(input.workspace);
  if (workspace === resolve(input.snapshotDataDirectory) || workspace.startsWith(resolve(input.snapshotDataDirectory) + '/')) throw new Error("The copied snapshot must be independent of the writable drill workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(workspace, "openship-platform-drill-")), data = join(work, "upgrade"), restored = join(work, "restored");
  await cp(input.snapshotDataDirectory, data, { recursive: true, errorOnExist: true, force: false });
  let connection: Awaited<ReturnType<typeof createDatabase>> | undefined;
  const open = (directory: string, migrationsDir: string, migrations: "apply" | "verify") => createDatabase({ driver: "pglite", dataDir: directory, migrationsDir, migrations, pgliteAssetsDir: input.assetsDirectory });
  try {
    connection = await open(data, input.oldMigrationsDirectory, "verify");
    const before = await snapshot(connection.db); await connection.close(); connection = undefined;
    connection = await open(data, input.targetMigrationsDirectory, "apply");
    await createConfigurationSecretsRepo(connection.db, key).backfillLegacy();
    const after = await snapshot(connection.db, before.fields);
    if (before.fingerprint !== after.fingerprint) throw new Error("Copied platform configuration, projects or users changed across migration");
    const wrong = createEncryption("isolated-drill-deliberately-wrong-encryption-key");
    let wrongKeyRejected = false;
    try { await createConfigurationSecretsRepo(connection.db, wrong).assertReadable(); }
    catch { wrongKeyRejected = true; }
    finally { wrong.close(); }
    if (!wrongKeyRejected) throw new Error("Copied database has no validated ciphertext; wrong-key rejection is unproven");
    const migrations = Number((await connection.db.execute(sql`select count(*)::int as count from drizzle.__drizzle_migrations`)).rows[0]!.count);
    await connection.close(); connection = undefined;
    await cp(input.snapshotDataDirectory, restored, { recursive: true, errorOnExist: true, force: false });
    connection = await open(restored, input.oldMigrationsDirectory, "verify");
    if ((await snapshot(connection.db, before.fields)).fingerprint !== before.fingerprint) throw new Error("Matching old database/key restore failed");
    await connection.close(); connection = undefined;
    let targetRejectedOldSnapshot = false;
    try { connection = await open(restored, input.targetMigrationsDirectory, "verify"); }
    catch { targetRejectedOldSnapshot = true; }
    if (!targetRejectedOldSnapshot) throw new Error("Target schema verifier accepted the old snapshot without migration");
    return { upgradeVerified: true, wrongKeyRejected, matchingRestoreVerified: true, targetRejectedOldSnapshot, migrations, projects: before.projects, users: before.users, services: before.services, deployments: before.deployments };
  } finally { await connection?.close(); key.close(); await rm(work, { recursive: true, force: true }); }
}

if (process.argv[2] === "--drill") {
  try {
    const input: Input = JSON.parse(await readFile(process.argv[3]!, "utf8"));
    console.log(JSON.stringify(await verifyCopiedPgliteUpgrade(input)));
  } catch { console.error("Isolated copied-platform migration/encryption/restore verification failed"); process.exitCode = 1; }
}
