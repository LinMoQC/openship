import { beforeAll, afterAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import Dockerode from "dockerode";
import { sql } from "drizzle-orm";
import { createDatabase, createRepositories, type DatabaseConnection } from "@repo/db/factory";
import { createEncryption } from "@repo/db/encryption";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";
import { isolatedPostgresProxy } from "../helpers/isolated-postgres-proxy";
import { GITOPS_POSTGRES_IMAGE } from "../helpers/gitops-test-images";

describeDockerE2E("isolated PostgreSQL control-platform upgrade and matching rollback", () => {
  const docker = new Dockerode({ socketPath: dockerSocketPath });
  const migrations = resolve("../../packages/db/drizzle");
  const key = createEncryption("isolated-platform-original-test-key");
  let container: Dockerode.Container, network: Dockerode.Network, directory: string, prefix: string, url: string;
  let connection: DatabaseConnection | undefined;
  let proxy: Awaited<ReturnType<typeof isolatedPostgresProxy>> | undefined;
  function command(args: string[], input?: Buffer): Promise<Buffer> {
    // Keep the event loop available to the isolated database relay, including
    // the client's final Terminate message before a matching restore.
    return new Promise((resolve, reject) => {
      const child = execFile("docker", ["--host", `unix://${dockerSocketPath}`, "exec", "-i", container.id, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH } }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(input);
    });
  }
  beforeAll(async () => {
    await requireDocker();
    directory = await mkdtemp(join(tmpdir(), "openship-pg-upgrade-")); prefix = join(directory, "old-migrations");
    await mkdir(join(prefix, "meta"), { recursive: true });
    const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
    // Last migration in the retained Magic v0.7.2 baseline; never a count of Core migrations.
    const end = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0122_data_transfer_staging");
    expect(end).toBeGreaterThan(0);
    const entries = journal.entries.slice(0, end + 1);
    for (const entry of entries) await copyFile(join(migrations, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`));
    await writeFile(join(prefix, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    // Required cached fixture; absence fails the gate instead of skipping.
    const imageId = (await docker.getImage(GITOPS_POSTGRES_IMAGE).inspect()).Id;
    network = await docker.createNetwork({ Name: `openship-test-isolated-${process.pid}`, Internal: true, Labels: { "openship.test": "platform-upgrade" } });
    container = await docker.createContainer({ Image: imageId, Env: ["POSTGRES_PASSWORD=isolated-test-password", "POSTGRES_DB=platform"], Labels: { "openship.test": "platform-upgrade" },
      HostConfig: { NetworkMode: network.id },
    });
    await container.start();
    const inspection = await container.inspect();
    expect(inspection.HostConfig.PortBindings ?? {}).toEqual({});
    expect(inspection.Mounts.some(mount => mount.Type === "bind")).toBe(false);
    // PostgreSQL may still be initializing. This check runs inside the isolated
    // container; it never dials a host or business database.
    await command(["sh", "-c", "for n in $(seq 1 60); do pg_isready -U postgres -d platform >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1"]);
    proxy = await isolatedPostgresProxy(docker, container);
    url = `postgresql://postgres:isolated-test-password@127.0.0.1:${proxy.port}/platform`;
    connection = await createDatabase({ driver: "pg", url, migrationsDir: prefix });
  }, 180_000);
  afterAll(async () => {
    await connection?.close(); key.close();
    await proxy?.close();
    await container?.remove({ force: true, v: true });
    await network?.remove();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 60_000);

  it("upgrades populated v0.7.2 state, encrypts old config and rejects the wrong key", async () => {
    await connection!.db.execute(sql`insert into organization(id,name) values ('org','Isolated platform')`);
    await connection!.db.execute(sql`insert into project_app(id,organization_id,name,slug) values ('app','org','Test','test')`);
    await connection!.db.execute(sql`insert into project(id,organization_id,app_id,name,slug) values ('project','org','app','Test','test')`);
    await connection!.db.execute(sql`insert into service(id,project_id,name,environment) values ('service','project','web','{"PASSWORD":"isolated-inline-test-secret"}'::jsonb)`);
    const backup = await command(["pg_dump", "-U", "postgres", "--no-owner", "--no-acl", "platform"]);
    expect(backup.byteLength).toBeGreaterThan(1000);
    await connection!.close(); connection = await createDatabase({ driver: "pg", url, migrationsDir: migrations });
    const repositories = createRepositories(connection.db, key);
    await repositories.configurationSecrets.backfillLegacy();
    expect((await repositories.service.findById("service"))?.environment).toEqual({ PASSWORD: "isolated-inline-test-secret" });
    const stored = await connection.db.execute(sql`select environment from service where id='service'`);
    expect(JSON.stringify(stored.rows)).not.toContain("isolated-inline-test-secret");
    const wrong = createEncryption("isolated-platform-wrong-test-key");
    try { await expect(createRepositories(connection.db, wrong).configurationSecrets.backfillLegacy()).rejects.toThrow(/decrypt/); }
    finally { wrong.close(); }
    expect((await connection.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]).toMatchObject({ n: JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8")).entries.length });
    await connection.close(); connection = undefined;
    await command(["dropdb", "-U", "postgres", "platform"]); await command(["createdb", "-U", "postgres", "platform"]);
    await command(["psql", "-U", "postgres", "-d", "platform", "--set", "ON_ERROR_STOP=1"], backup);
    connection = await createDatabase({ driver: "pg", url, migrationsDir: prefix, migrations: "verify" });
    expect((await connection.db.execute(sql`select environment from service where id='service'`)).rows[0]).toMatchObject({ environment: { PASSWORD: "isolated-inline-test-secret" } });
    await connection.close(); connection = undefined;
    await expect(createDatabase({ driver: "pg", url, migrationsDir: migrations, migrations: "verify" })).rejects.toThrow(/schema verification/);
  });
});
