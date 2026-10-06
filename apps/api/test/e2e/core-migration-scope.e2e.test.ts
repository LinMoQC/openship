import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { BuildLogger, DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos } from "@repo/db";
import { deployComposeServices } from "@repo/platform/engine/modules/deployments/compose/deploy.service";
import { LOCAL_HOST_PORT_TARGET } from "@repo/platform/engine/lib/host-port-target";
import { describeDockerE2E, requireDocker, dockerSocketPath } from "../helpers/docker-e2e";
import { GITOPS_BUSYBOX_IMAGE, GITOPS_POSTGRES_IMAGE } from "../helpers/gitops-test-images";
import { seedOrg, seedProject, seedService, seedDeployment, seedServiceDeployment, setActive } from "../helpers/seed";

// Core's migration is a Compose completion job, not releaseCommands. Drive the
// real orchestrator against an isolated PostgreSQL volume and a serving app.
// The location/routing seams select this test daemon, with no Edge or business
// credentials. Database, dependency waits and service activation are real.
describeDockerE2E("Core migration failure preserves the exact service scope", () => {
  let runtime: DockerRuntime, projectId = "", slug = "", volumeName: string | undefined;
  const healthcheck = { test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/"], interval: "1s", timeout: "1s", retries: 1 };
  beforeAll(async () => {
    await requireDocker(); runtime = await DockerRuntime.create({ transport: "socket" });
    // Missing pinned PostgreSQL is a release failure. CI pulls it explicitly.
    await runtime.docker.getImage(GITOPS_POSTGRES_IMAGE).inspect();
    await runtime.pullImage(GITOPS_BUSYBOX_IMAGE);
  }, 120_000);
  afterAll(async () => {
    if (projectId) for (const id of await runtime.listProjectContainerIds(projectId)) await runtime.destroy(id);
    if (slug) await runtime.removeNetwork(slug);
    if (volumeName) await runtime.docker.getVolume(volumeName).remove();
    await runtime?.dispose();
  }, 60_000);
  const pg = (container: string, statement: string) => new Promise<string>((resolve, reject) => {
    execFile("docker", ["--host", `unix://${dockerSocketPath}`, "exec", container, "psql", "-U", "postgres", "-d", "fixture", "--set", "ON_ERROR_STOP=1", "-Atc", statement],
      { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
  const http = (container: string) => new Promise<string>((resolve, reject) => {
    // The fixture's internal network deliberately has no host ingress. Probe the
    // actual HTTP server through Docker exec, without opening the database network.
    execFile("docker", ["--host", `unix://${dockerSocketPath}`, "exec", container,
      "wget", "-qO-", "http://127.0.0.1:3000/"],
      { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 15_000 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  it("a real failed SQL migration leaves the incumbent API, database ID, volume and active deployment untouched", async () => {
    const org = await seedOrg({ ownsHost: true });
    const project = await seedProject(org.organizationId, { framework: "docker", hasBuild: false, hasServer: true, runtimeMode: "docker", readiness: { preflight: false } });
    projectId = project.id; slug = project.slug;
    const active = await seedDeployment(project, { createdAt: new Date(Date.now() - 60_000), imageRef: "compose", containerId: "compose", meta: { runtimeMode: "docker", deployTarget: "local" } });
    await setActive(projectId, active.id);
    const network = await runtime.docker.createNetwork({ Name: `openship-${slug}`, Internal: true, Labels: { "openship.test": projectId } });
    const group = await runtime.ensureServiceGroup({ projectId, slug, deploymentId: active.id });
    expect(group.id).toBe(network.id);
    const database = await seedService(projectId, { name: "magic-postgres", image: GITOPS_POSTGRES_IMAGE, volumes: ["database-data:/var/lib/postgresql/data"], namespaceVolumes: true,
      environment: { POSTGRES_PASSWORD: "isolated-fixture-only", POSTGRES_DB: "fixture" },
      advanced: { healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres -d fixture"], interval: "1s", timeout: "1s", retries: 60 } } });
    const liveDatabase = await runtime.deployServiceWorkload(group, { projectId, slug, deploymentId: active.id, serviceName: database.name, image: GITOPS_POSTGRES_IMAGE,
      ports: [], volumes: database.volumes as string[], namespaceVolumes: true, environment: { POSTGRES_PASSWORD: "isolated-fixture-only", POSTGRES_DB: "fixture" }, advanced: database.advanced!, imageAlreadyPrepared: true });
    await runtime.waitForServiceCondition(liveDatabase.containerId, "service_healthy", 60_000);
    const databaseInfo = await runtime.docker.getContainer(liveDatabase.containerId).inspect();
    expect(databaseInfo.HostConfig.PortBindings ?? {}).toEqual({});
    volumeName = databaseInfo.Mounts.find(mount => mount.Destination === "/var/lib/postgresql/data")!.Name;
    await pg(liveDatabase.containerId, "CREATE TABLE sentinel(id int primary key); INSERT INTO sentinel VALUES (42)");
    await seedServiceDeployment(active.id, database, { containerId: liveDatabase.containerId, imageRef: GITOPS_POSTGRES_IMAGE });
    const migration = await seedService(projectId, { name: "migrate", image: GITOPS_POSTGRES_IMAGE, restart: "no", volumes: [], dependsOn: ["magic-postgres"],
      commandArgv: ["psql", "--set", "ON_ERROR_STOP=1", "-c", "BEGIN; CREATE TABLE candidate_schema(id int); SELECT missing_column FROM sentinel; COMMIT;"],
      environment: { PGHOST: "magic-postgres", PGUSER: "postgres", PGPASSWORD: "isolated-fixture-only", PGDATABASE: "fixture" },
      advanced: { runToCompletion: true, dependsOnConditions: { "magic-postgres": { condition: "service_healthy" } } } });
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
        const address = server.address(); if (!address || typeof address === "string") return reject(Error("Missing isolated port"));
        server.close(() => resolve(address.port));
      });
    });
    const command = "mkdir -p /tmp/www; echo incumbent > /tmp/www/index.html; exec httpd -f -p 3000 -h /tmp/www";
    const api = await seedService(projectId, { name: "platform-api", image: GITOPS_BUSYBOX_IMAGE, ports: [`127.0.0.1:${port}:3000`], volumes: [], command,
      dependsOn: ["migrate"], advanced: { healthcheck, dependsOnConditions: { migrate: { condition: "service_completed_successfully" } }, readiness: { preflight: true, stabilizationSeconds: 15 } } });
    const serving = await runtime.deployServiceWorkload(group, { projectId, slug, deploymentId: active.id, serviceName: api.name, image: GITOPS_BUSYBOX_IMAGE,
      ports: api.ports as string[], volumes: [], namespaceVolumes: true, environment: {}, command, advanced: { healthcheck }, imageAlreadyPrepared: true });
    await runtime.waitForServiceCondition(serving.containerId, "service_healthy", 15_000);
    const servingInfo = await runtime.docker.getContainer(serving.containerId).inspect();
    expect(await http(serving.containerId)).toBe("incumbent\n");
    await seedServiceDeployment(active.id, api, { containerId: serving.containerId, imageRef: GITOPS_BUSYBOX_IMAGE, hostPort: port, hostPorts: { 3000: port } });
    const attempt = await seedDeployment(project, { status: "deploying", imageRef: "compose", containerId: "compose", meta: { runtimeMode: "docker", deployTarget: "local", strictServiceScope: true, targetServiceIds: [migration.id, api.id] } });
    const logs: string[] = [];
    const result = await deployComposeServices((await repos.project.findById(projectId))!, attempt, runtime, new BuildLogger(entry => logs.push(entry.message)), {
      strictScope: true, targetServiceIds: new Set([migration.id, api.id]), preparedLocalImages: new Map([[migration.id, GITOPS_POSTGRES_IMAGE], [api.id, GITOPS_BUSYBOX_IMAGE]]),
      routing: new NoopInfraProvider(), ssl: new NoopInfraProvider(), usesManagedRouting: false, executor: createHostExecutor(), localHost: true, hostPortTarget: LOCAL_HOST_PORT_TARGET,
    });
    expect(result.status, JSON.stringify({ result, logs })).toBe("failed");
    expect(result.summary.failedServices).toEqual(expect.arrayContaining(["migrate", "platform-api"]));
    expect((await runtime.docker.getContainer(serving.containerId).inspect()).State.Running).toBe(true);
    expect(await http(serving.containerId)).toBe("incumbent\n");
    expect((await runtime.docker.getContainer(serving.containerId).inspect()).HostConfig.PortBindings)
      .toEqual(servingInfo.HostConfig.PortBindings);
    expect((await runtime.docker.getContainer(liveDatabase.containerId).inspect()).Mounts).toEqual(databaseInfo.Mounts);
    expect(await pg(liveDatabase.containerId, "SELECT id FROM sentinel")).toBe("42");
    expect(await pg(liveDatabase.containerId, "SELECT to_regclass('candidate_schema') IS NULL")).toBe("t");
    expect((await repos.project.findById(projectId))!.activeDeploymentId).toBe(active.id);
    expect(await repos.releases.journals(projectId)).toEqual([]);
  });
});
