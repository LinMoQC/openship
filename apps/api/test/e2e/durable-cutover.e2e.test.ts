import { beforeAll, afterAll, expect, it, vi } from "vitest";
import Dockerode from "dockerode";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { repos } from "@repo/db";
import { DockerRuntime, type ServiceCutoverRecord } from "@repo/adapters";
import { GITOPS_BUSYBOX_IMAGE } from "../helpers/gitops-test-images";
import { deployPreflightedService } from "../../../../packages/adapters/src/runtime/docker-preflight";
import { settleServiceCutover } from "../../../../packages/adapters/src/runtime/docker-cutover";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject, seedDeployment, seedService, seedServiceDeployment } from "../helpers/seed";
import { recoverInterruptedReleaseCutovers } from "@repo/platform/engine/modules/releases/release-cutover";

// Select the isolated local Docker host without provisioning Edge. Every
// recovery, container operation and database read below uses the real product.
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  resolveDeploymentRuntimeForRead: async () => ({ runtime: await DockerRuntime.create({ transport: "socket" }), serverId: null }),
  disposeRuntime: (runtime: DockerRuntime) => { void runtime.dispose(); },
}));

describeDockerE2E("durable stateless cutover against real Docker and PGlite", () => {
  const docker = new Dockerode({ socketPath: dockerSocketPath });
  const ownedProjects: string[] = [];
  let imageId: string;
  beforeAll(async () => {
    await requireDocker();
    const runtime = await DockerRuntime.create({ transport: "socket" });
    try { await runtime.pullImage(GITOPS_BUSYBOX_IMAGE); } finally { await runtime.dispose(); }
    imageId = (await docker.getImage(GITOPS_BUSYBOX_IMAGE).inspect()).Id;
  }, 120_000);
  afterAll(async () => {
    for (const project of ownedProjects) {
      const containers = await docker.listContainers({ all: true, filters: { label: [`openship.project=${project}`] } });
      for (const row of containers) await docker.getContainer(row.Id).remove({ force: true });
    }
  }, 60_000);

  async function fixture() {
    const org = await seedOrg({ ownsHost: true }), project = await seedProject(org.organizationId, { hasBuild: false, hasServer: true, runtimeMode: "docker" });
    ownedProjects.push(project.id);
    const previous = await seedDeployment(project, { meta: { runtimeMode: "docker", deployTarget: "local" } });
    const dep = await seedDeployment(project, { meta: { runtimeMode: "docker", deployTarget: "local", releaseRunId: randomUUID() } });
    const port = await new Promise<number>(resolve => {
      const server = createServer(); server.listen(0, "127.0.0.1", () => {
        const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test port");
        server.close(() => resolve(address.port));
      });
    });
    const name = `openship-cutover-test-${randomUUID()}`;
    const payload: Dockerode.ContainerCreateOptions = {
      name, Image: imageId, Hostname: "web",
      Cmd: ["sh", "-c", "mkdir -p /tmp/www; echo incumbent > /tmp/www/index.html; exec httpd -f -p 3000 -h /tmp/www"],
      Labels: { "openship.project": project.id, "openship.deployment": previous.id, "openship.service": "web" },
      Healthcheck: { Test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/"], Interval: 1_000_000_000, Timeout: 1_000_000_000, Retries: 1 },
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: { PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } },
    };
    const old = await docker.createContainer(payload); await old.start();
    const url = `http://127.0.0.1:${port}/`;
    const read = async () => (await fetch(url, { signal: AbortSignal.timeout(2000) })).text();
    for (let i = 0; i < 50 && (await old.inspect()).State.Health?.Status !== "healthy"; i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(await read()).toBe("incumbent\n");
    const save = async (record: ServiceCutoverRecord) => { expect((await repos.releases.journal(record)).id).toBe(record.id); };
    const journal = { releaseRunId: String((dep.meta as { releaseRunId: string }).releaseRunId), previousDeploymentId: previous.id, save };
    const record = async () => {
      const row = (await repos.releases.journals(project.id))[0]!;
      return { ...row, context: row.context } as unknown as ServiceCutoverRecord;
    };
    const target = { ...payload, Labels: { ...payload.Labels, "openship.deployment": dep.id }, Cmd: payload.Cmd!.map(x => x.replace("incumbent", "replacement")) };
    return { project, dep, previous, old, payload, target, journal, save, read, record, url, org };
  }

  it("keeps a serving incumbent through an unhealthy candidate and records verified restoration", async () => {
    const f = await fixture();
    await expect(deployPreflightedService(docker, { ...f.target, Healthcheck: { ...f.payload.Healthcheck, Test: ["CMD", "false"] } }, { timeoutMs: 5000, journal: f.journal }, () => {})).rejects.toThrow(/unhealthy/);
    expect((await f.old.inspect()).State.Running).toBe(true);
    expect(await f.read()).toBe("incumbent\n");
    expect((await f.record()).stage).toBe("restored");
  });

  it("leaves the incumbent reachable when the real Docker daemon cannot pull the target registry image", async () => {
    const f = await fixture(), runtime = await DockerRuntime.create({ transport: "socket" });
    const slug = `pull-failure-${randomUUID()}`;
    await f.old.rename({ name: `openship-${slug}-web` });
    const logs: string[] = [];
    try {
      await expect(runtime.deployServiceWorkload({ id: "unused-before-pull" }, {
        projectId: f.project.id, deploymentId: f.dep.id, slug, serviceName: "web",
        image: `127.0.0.1:1/isolated-no-registry@sha256:${"a".repeat(64)}`,
        environment: {}, volumes: [], namespaceVolumes: true, ports: [],
        healthcheckPreflight: { timeoutMs: 5000, journal: f.journal },
      }, row => logs.push(row.message))).rejects.toThrow(/pull|connect|registry/i);
      expect(logs.some(line => line.startsWith("Pulling image "))).toBe(true);
      expect((await f.old.inspect()).State.Running).toBe(true);
      expect(await f.read()).toBe("incumbent\n");
      expect(await repos.releases.journals(f.project.id)).toEqual([]);
    } finally { await runtime.dispose(); }
  }, 60_000);

  it("refuses a direct stateful candidate before touching the serving container or its named volume", async () => {
    const f = await fixture();
    const volumeName = `openship-cutover-volume-${randomUUID()}`;
    await docker.createVolume({ Name: volumeName, Labels: { "openship.test": f.project.id } });
    try {
      await expect(deployPreflightedService(docker, { ...f.target, HostConfig: { ...f.target.HostConfig, Mounts: [{ Type: "volume", Source: volumeName, Target: "/state" }] } }, { timeoutMs: 5000, journal: f.journal }, () => {})).rejects.toThrow(/volumes/);
      expect((await f.old.inspect()).State.Running).toBe(true);
      expect(await f.read()).toBe("incumbent\n");
      expect(await repos.releases.journals(f.project.id)).toEqual([]);
      expect((await docker.getVolume(volumeName).inspect()).Name).toBe(volumeName);
      expect((await docker.listContainers({ all: true, filters: { label: [`openship.project=${f.project.id}`] } })).map(c => c.Id)).toEqual([f.old.id]);
    } finally { await docker.getVolume(volumeName).remove(); }
  });

  it("recovers the exact incumbent after final-container health failure and preserves its fixed port", async () => {
    const f = await fixture();
    await expect(deployPreflightedService(docker, { ...f.target, Healthcheck: { ...f.payload.Healthcheck, Test: ["CMD-SHELL", 'test "$HOSTNAME" != web && wget -q -O /dev/null http://127.0.0.1:3000/'] } }, { timeoutMs: 5000, journal: f.journal }, () => {})).rejects.toThrow(/unhealthy/);
    expect((await f.old.inspect()).Name).toBe(`/${f.payload.name}`);
    expect(await f.read()).toBe("incumbent\n");
    expect((await f.record()).stage).toBe("restored");
  });

  it("retains the old container until external acceptance and can recover from persisted records alone", async () => {
    const f = await fixture();
    await deployPreflightedService(docker, f.target, { timeoutMs: 5000, journal: f.journal }, () => {});
    expect((await f.old.inspect()).State.Running).toBe(false);
    expect((await f.record()).stage).toBe("awaiting_acceptance");
    expect(await f.read()).toBe("replacement\n");
    // No activation closure is retained. A new connection reads the database.
    const restarted = new Dockerode({ socketPath: dockerSocketPath });
    await settleServiceCutover(restarted, await f.record(), "restore", f.save);
    expect(await f.read()).toBe("incumbent\n");
    expect((await f.record()).stage).toBe("restored");
  });

  it("reconstructs an interrupted stop/rename from durable intent without deploying again", async () => {
    const f = await fixture();
    let disconnected = false;
    const save = async (record: ServiceCutoverRecord) => {
      if (disconnected) throw new Error("Control process connection lost");
      await f.save(record);
      if (record.stage === "replacement_creating") { disconnected = true; throw new Error("Control process connection lost"); }
    };
    await expect(deployPreflightedService(docker, f.target, { timeoutMs: 5000, journal: { ...f.journal, save } }, () => {})).rejects.toThrow();
    expect((await f.record()).stage).toBe("replacement_creating");
    expect((await f.old.inspect()).State.Running).toBe(false);
    await settleServiceCutover(new Dockerode({ socketPath: dockerSocketPath }), await f.record(), "restore", f.save);
    expect(await f.read()).toBe("incumbent\n");
    expect((await f.old.inspect()).Name).toBe(`/${f.payload.name}`);
  });

  it("cleans the retained incumbent only after acceptance and safely repeats cleanup", async () => {
    const f = await fixture();
    await deployPreflightedService(docker, f.target, { timeoutMs: 5000, journal: f.journal }, () => {});
    const record = await f.record();
    expect(record.imageId).toBe(imageId);
    expect(JSON.stringify(record)).not.toContain("Env");
    await settleServiceCutover(docker, record, "commit", f.save);
    await settleServiceCutover(docker, await f.record(), "commit", f.save);
    expect((await f.record()).stage).toBe("committed");
    await expect(f.old.inspect()).rejects.toMatchObject({ statusCode: 404 });
    expect(await f.read()).toBe("replacement\n");
  });

  it("records cancellation after preflight while keeping the incumbent reachable", async () => {
    const f = await fixture(), abort = new AbortController();
    const save = async (record: ServiceCutoverRecord) => {
      await f.save(record);
      if (record.stage === "preflight_starting") abort.abort(new Error("cancelled"));
    };
    await expect(deployPreflightedService(docker, f.target, { timeoutMs: 5000, signal: abort.signal, journal: { ...f.journal, save } }, () => {})).rejects.toThrow("cancelled");
    expect(await f.read()).toBe("incumbent\n");
    expect((await f.record()).stage).toBe("restored");
  });

  it("an unavailable image fails before a journal or serving container changes", async () => {
    const f = await fixture();
    await expect(deployPreflightedService(docker, { ...f.target, Image: `missing-test-image-${randomUUID()}` }, { timeoutMs: 5000, journal: f.journal }, () => {})).rejects.toThrow();
    expect(await repos.releases.journals(f.project.id)).toHaveLength(0);
    expect(await f.read()).toBe("incumbent\n");
  });

  it("a real candidate start failure preserves the incumbent and removes the failed candidate", async () => {
    const f = await fixture();
    await expect(deployPreflightedService(docker, { ...f.target, Entrypoint: ["/missing-executable"] }, { timeoutMs: 5000, journal: f.journal }, () => {})).rejects.toThrow();
    expect(await f.read()).toBe("incumbent\n");
    expect((await f.record()).stage).toBe("restored");
    expect(await docker.listContainers({ all: true, filters: { label: [`openship.cutover=${(await f.record()).id}`] } })).toHaveLength(0);
  });

  it("a candidate health timeout never stops the serving instance", async () => {
    const f = await fixture();
    await expect(deployPreflightedService(docker, { ...f.target, Healthcheck: { Test: ["CMD", "true"], Interval: 30_000_000_000 } }, { timeoutMs: 200, journal: f.journal }, () => {})).rejects.toThrow(/timed out/);
    expect((await f.old.inspect()).State.Running).toBe(true);
    expect(await f.read()).toBe("incumbent\n");
    expect((await f.record()).stage).toBe("restored");
  });

  it("a project ownership mismatch is rejected before creating a candidate or journal", async () => {
    const f = await fixture();
    await expect(deployPreflightedService(docker, { ...f.target, Labels: { ...f.target.Labels, "openship.project": "foreign-project" } }, { timeoutMs: 5000, journal: f.journal }, () => {})).rejects.toThrow(/foreign/);
    expect(await repos.releases.journals(f.project.id)).toHaveLength(0);
    expect(await f.read()).toBe("incumbent\n");
  });

  it("a real external HTTP 503 after cutover restores the original fixed-port service", async () => {
    const f = await fixture();
    const cmd = f.target.Cmd![2]!.replace("exec httpd", "mkdir -p /tmp/www/cgi-bin; printf '#!/bin/sh\\nprintf \"Status: 503 Service Unavailable\\\\r\\\\nContent-Type: text/plain\\\\r\\\\n\\\\r\\\\nunavailable\"\\n' > /tmp/www/cgi-bin/probe; chmod +x /tmp/www/cgi-bin/probe; exec httpd");
    await deployPreflightedService(docker, { ...f.target, Cmd: ["sh", "-c", cmd] }, { timeoutMs: 5000, journal: f.journal }, () => {});
    expect((await fetch(`${f.url}cgi-bin/probe`, { signal: AbortSignal.timeout(2000) })).status).toBe(503);
    await settleServiceCutover(new Dockerode({ socketPath: dockerSocketPath }), await f.record(), "restore", f.save);
    expect((await f.old.inspect()).Name).toBe(`/${f.payload.name}`);
    expect(await f.read()).toBe("incumbent\n");
  });

  it("a deferred incumbent cleanup remains durable and completes after reconnect", async () => {
    const f = await fixture();
    await deployPreflightedService(docker, f.target, { timeoutMs: 5000, journal: f.journal }, () => {});
    const get = docker.getContainer.bind(docker);
    const fault = vi.spyOn(docker, "getContainer").mockImplementation(id => {
      const handle = get(id);
      if (id === f.old.id) handle.remove = async () => { throw new Error("Injected Docker cleanup failure"); };
      return handle;
    });
    try { await expect(settleServiceCutover(docker, await f.record(), "commit", f.save)).rejects.toThrow("cleanup failure"); }
    finally { fault.mockRestore(); }
    expect((await f.record()).stage).toBe("commit_pending");
    expect((await f.old.inspect()).State.Running).toBe(false);
    expect(await f.read()).toBe("replacement\n");
    await settleServiceCutover(new Dockerode({ socketPath: dockerSocketPath }), await f.record(), "commit", f.save);
    expect((await f.record()).stage).toBe("committed");
    await expect(f.old.inspect()).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a recovery start failure is explicit and reconnect restores the same incumbent ID", async () => {
    const f = await fixture();
    await deployPreflightedService(docker, f.target, { timeoutMs: 5000, journal: f.journal }, () => {});
    const get = docker.getContainer.bind(docker);
    const fault = vi.spyOn(docker, "getContainer").mockImplementation(id => {
      const handle = get(id);
      if (id === f.old.id) handle.start = async () => { throw new Error("Injected Docker recovery failure"); };
      return handle;
    });
    try { await expect(settleServiceCutover(docker, await f.record(), "restore", f.save)).rejects.toThrow("recovery failure"); }
    finally { fault.mockRestore(); }
    expect((await f.record()).stage).toBe("recovery_failed");
    expect((await f.old.inspect()).State.Running).toBe(false);
    await settleServiceCutover(new Dockerode({ socketPath: dockerSocketPath }), await f.record(), "restore", f.save);
    expect((await f.record()).stage).toBe("restored");
    expect(await f.read()).toBe("incumbent\n");
  });

  it("recovery refuses a foreign serving container and keeps its port and old instance intact", async () => {
    const f = await fixture();
    const transaction = await deployPreflightedService(
      docker,
      f.target,
      { timeoutMs: 5000, journal: f.journal },
      () => {},
    );
    await transaction.container.stop();
    await transaction.container.rename({ name: `${f.payload.name}-external` });
    const foreign = await docker.createContainer({
      ...f.payload,
      Cmd: ["sh", "-c", `sleep 0.5; ${f.payload.Cmd![2]!.replace("incumbent", "foreign")}`],
    });
    try {
      await foreign.start();
      // Docker start acknowledges the process before its HTTP listener is ready.
      // Establish the serving precondition, including a deliberately slow boot,
      // before checking that recovery leaves this unrelated service untouched.
      await vi.waitFor(async () => expect(await f.read()).toBe("foreign\n"), {
        timeout: 5000,
        interval: 100,
      });
      await expect(
        settleServiceCutover(docker, await f.record(), "restore", f.save),
      ).rejects.toThrow(/foreign/);
      expect((await f.record()).stage).toBe("recovery_failed");
      expect((await foreign.inspect()).State.Running).toBe(true);
      expect((await f.old.inspect()).State.Running).toBe(false);
      expect(await f.read()).toBe("foreign\n");
    } finally {
      // A failed assertion must not leave an ownerless pending journal for the
      // later startup-recovery cases, which inspect the complete test database.
      await foreign.remove({ force: true });
      await settleServiceCutover(docker, await f.record(), "restore", f.save);
    }
    expect(await f.read()).toBe("incumbent\n");
  });

  async function seedEngineRun(f: Awaited<ReturnType<typeof fixture>>, extraServices: string[] = []) {
    const service = await seedService(f.project.id, { name: "web", image: "busybox:1.37.0" });
    await seedServiceDeployment(f.previous.id, service, { containerId: f.old.id });
    const runtime = await DockerRuntime.create({ transport: "socket" });
    let actual;
    try { actual = await runtime.inspectReleaseContainer(f.old.id, "busybox"); }
    finally { await runtime.dispose(); }
    const now = new Date(), planId = randomUUID();
    await repos.releases.createPlan({ id: planId, projectId: f.project.id, organizationId: f.org.organizationId, bindingRevision: 1, summaryHash: "a".repeat(64), createdAt: now, expiresAt: new Date(now.getTime() + 600_000), snapshot: {
      current: { deploymentId: f.previous.id, images: { web: { image: actual.image, digest: actual.digest, gitSha: null } } }, target: { services: ["web", ...extraServices] },
    } });
    await repos.releases.reserve({ id: f.journal.releaseRunId, planId, projectId: f.project.id, organizationId: f.org.organizationId, userId: f.org.userId, githubActor: "fixture", idempotencyKey: randomUUID(), stage: "deploying", deploymentId: f.dep.id }, now);
    await repos.project.setActiveDeployment(f.project.id, f.dep.id);
  }

  it("the real startup recovery operation restores persisted Docker journals and the active deployment pointer", async () => {
    const f = await fixture(); await seedEngineRun(f);
    await deployPreflightedService(docker, f.target, { timeoutMs: 5000, journal: f.journal }, () => {});
    await recoverInterruptedReleaseCutovers();
    expect((await repos.releases.run(f.journal.releaseRunId))!.stage).toBe("restored");
    expect((await repos.project.findById(f.project.id))!.activeDeploymentId).toBe(f.previous.id);
    expect((await repos.deployment.findById(f.dep.id))!.status).toBe("failed");
    expect(await f.read()).toBe("incumbent\n");
    await recoverInterruptedReleaseCutovers();
    expect((await repos.project.findById(f.project.id))!.activeDeploymentId).toBe(f.previous.id);
  });

  it("startup marks a mixed Core scope for manual recovery without claiming whole-stack restoration", async () => {
    const f = await fixture(); await seedEngineRun(f, ["migrate", "database"]);
    await deployPreflightedService(docker, f.target, { timeoutMs: 5000, journal: f.journal }, () => {});
    await recoverInterruptedReleaseCutovers();
    expect((await repos.releases.run(f.journal.releaseRunId))!.stage).toBe("action_required");
    expect((await repos.project.findById(f.project.id))!.activeDeploymentId).toBe(f.dep.id);
    expect(await f.read()).toBe("incumbent\n");
  });

  it("startup completes accepted cleanup without restoring an accepted release", async () => {
    const f = await fixture(); await seedEngineRun(f);
    await deployPreflightedService(docker, f.target, { timeoutMs: 5000, journal: f.journal }, () => {});
    await repos.releases.updateRun(f.journal.releaseRunId, { stage: "accepted" });
    await recoverInterruptedReleaseCutovers();
    expect((await f.record()).stage).toBe("committed");
    expect((await repos.releases.run(f.journal.releaseRunId))!.stage).toBe("accepted");
    expect((await repos.project.findById(f.project.id))!.activeDeploymentId).toBe(f.dep.id);
    expect(await f.read()).toBe("replacement\n");
  });

  for (const [stack, stage] of [["admin", "cutover_renaming"], ["commercial-web", "replacement_creating"], ["magic-core-stateless", "awaiting_acceptance"]]) {
    it(`${stack}: restores the serving container after a literal SIGKILL and persisted PGlite reopen at ${stage}`, async () => {
      const f = await fixture(), dir = await mkdtemp(join(tmpdir(), "openship-cutover-crash-"));
      const input = join(dir, "input.json"), journalPath = join(dir, "journal");
      await writeFile(input, JSON.stringify({ target: f.target, socketPath: dockerSocketPath, releaseRunId: f.journal.releaseRunId, previousDeploymentId: f.journal.previousDeploymentId }), { mode: 0o600 });
      const child = spawn("bun", [resolve("test/fixtures/cutover-crash-worker.ts"), input, journalPath, stage!], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
      let diagnostics = ""; child.stderr.on("data", chunk => { diagnostics += String(chunk); });
      try {
        await new Promise<void>((resolveReady, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Child did not reach durable intent: ${diagnostics.slice(-2000)}`)), 30_000);
          let output = "";
          child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("CUTOVER_INTENT_DURABLE")) { clearTimeout(timeout); resolveReady(); } });
          child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Cutover child exited ${code}: ${diagnostics.slice(-2000)}`)); });
        });
        const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
        child.kill("SIGKILL"); await exited;
        const reopened = new PGlite(journalPath);
        try {
          const saved = (await reopened.query<{ record: ServiceCutoverRecord }>("SELECT record FROM cutover")).rows[0]!.record;
          expect(saved.stage).toBe(stage);
          await settleServiceCutover(new Dockerode({ socketPath: dockerSocketPath }), saved, "restore", async record => {
            await reopened.query("UPDATE cutover SET record=$1 WHERE id=$2", [record, record.id]);
          });
          expect((await reopened.query<{ record: ServiceCutoverRecord }>("SELECT record FROM cutover")).rows[0]!.record.stage).toBe("restored");
          expect((await f.old.inspect()).Name).toBe(`/${f.payload.name}`);
          expect(await f.read()).toBe("incumbent\n");
        } finally { await reopened.close(); }
      } finally {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
