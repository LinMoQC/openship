import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "node:net";
import { BuildLogger, DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos } from "@repo/db";
import { LOCAL_HOST_PORT_TARGET } from "../../src/lib/host-port-target";
import { deployComposeServices } from "../../src/modules/deployments/compose/deploy.service";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import {
  seedDeployment,
  seedOrg,
  seedProject,
  seedService,
  seedServiceDeployment,
  setActive,
} from "../helpers/seed";

const IMAGE = "busybox:1.37.0";
const healthcheck = {
  test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/"],
  interval: "1s",
  timeout: "1s",
  retries: 1,
  startPeriod: "1s",
};
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolve(address.port));
    });
  });
}

async function readEventually(url: string): Promise<string> {
  const deadline = Date.now() + 10000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await (await fetch(url, { signal: AbortSignal.timeout(1000) })).text();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw last;
}

describeDockerE2E("stateless candidate health before fixed-port cutover", () => {
  let runtime: DockerRuntime;
  let projectId = "",
    slug = "";
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    // An unavailable image is a test failure, never a silent skip.
    await runtime.pullImage(IMAGE);
  }, 120_000);
  afterAll(async () => {
    if (projectId)
      for (const id of await runtime.listProjectContainerIds(projectId)) await runtime.destroy(id);
    if (slug) await runtime.removeNetwork(slug);
    await runtime?.dispose();
  }, 120_000);

  it("a failed Compose candidate leaves the old container ID and HTTP response unchanged; healthy replacement succeeds", async () => {
    const org = await seedOrg();
    const project = await seedProject(org.organizationId, {
      framework: "docker",
      hasBuild: false,
      hasServer: true,
      runtimeMode: "docker",
      readiness: { preflight: true, stabilizationSeconds: 15 },
    });
    projectId = project.id;
    slug = project.slug;
    const port = await freePort();
    const ports = [`127.0.0.1:${port}:3000`];
    const command =
      "mkdir -p /tmp/www && echo incumbent > /tmp/www/index.html && exec httpd -f -p 3000 -h /tmp/www";
    const svc = await seedService(project.id, {
      name: "web",
      image: IMAGE,
      ports,
      volumes: [],
      command,
      namespaceVolumes: true,
      exposed: false,
      advanced: { healthcheck },
    });
    const active = await seedDeployment(project, {
      createdAt: new Date(Date.now() - 60_000),
      imageRef: "compose",
      containerId: "compose",
      meta: { runtimeMode: "docker", deployTarget: "local" },
    });
    await setActive(project.id, active.id);
    const group = await runtime.ensureServiceGroup({ projectId, slug, deploymentId: active.id });
    const incumbent = await runtime.deployServiceWorkload(group, {
      deploymentId: active.id,
      projectId,
      slug,
      serviceName: "web",
      image: IMAGE,
      ports,
      volumes: [],
      environment: {},
      namespaceVolumes: true,
      command,
      advanced: { healthcheck },
      imageAlreadyPrepared: true,
    });
    await runtime.waitForServiceCondition(incumbent.containerId, "service_healthy", 15_000);
    await seedServiceDeployment(active.id, svc, {
      containerId: incumbent.containerId,
      imageRef: IMAGE,
      hostPort: port,
      hostPorts: { 3000: port },
    });
    const url = `http://127.0.0.1:${port}/`;
    expect(await readEventually(url)).toBe("incumbent\n");
    const attempt = async () => {
      const dep = await seedDeployment(project, {
        trigger: "manual",
        status: "deploying",
        imageRef: "compose",
        containerId: "compose",
        meta: { runtimeMode: "docker", deployTarget: "local" },
      });
      const result = await deployComposeServices(
        (await repos.project.findById(projectId))!,
        dep,
        runtime,
        new BuildLogger(() => undefined),
        {
          targetServiceIds: new Set([svc.id]),
          preparedLocalImages: new Map([[svc.id, IMAGE]]),
          routing: new NoopInfraProvider(),
          ssl: new NoopInfraProvider(),
          usesManagedRouting: false,
          executor: createHostExecutor(),
          localHost: true,
          hostPortTarget: LOCAL_HOST_PORT_TARGET,
        },
      );
      await repos.deployment.updateStatus(dep.id, result.status);
      return result;
    };
    await repos.service.update(svc.id, {
      advanced: { healthcheck: { ...healthcheck, test: ["CMD", "false"] } },
    });
    const samples: string[] = [];
    let sampling = true;
    const sample = (async () => {
      while (sampling) {
        samples.push(
          await fetch(url)
            .then((r) => r.text())
            .catch(() => "unreachable"),
        );
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    let failed;
    try {
      failed = await attempt();
    } finally {
      sampling = false;
      await sample;
    }
    expect(failed.status).toBe("failed");
    expect(samples.length).toBeGreaterThan(1);
    expect(samples.every((value) => value === "incumbent\n")).toBe(true);
    expect(await runtime.listProjectContainerIds(projectId)).toEqual([incumbent.containerId]);
    expect((await repos.project.findById(projectId))!.activeDeploymentId).toBe(active.id);

    // Candidate hostname is unique, but the replacement retains "web". Force a
    // failure only AFTER preflight to prove real fixed-port recovery, not just
    // rejection before the old container was ever touched.
    await repos.service.update(svc.id, {
      advanced: {
        healthcheck: {
          ...healthcheck,
          test: [
            "CMD-SHELL",
            'test "$HOSTNAME" != web && wget -q -O /dev/null http://127.0.0.1:3000/',
          ],
        },
      },
    });
    const activationFailure = await attempt();
    expect(activationFailure.status).toBe("failed");
    expect(await runtime.listProjectContainerIds(projectId)).toEqual([incumbent.containerId]);
    expect(await readEventually(url)).toBe("incumbent\n");

    // A later HTTP gate can fail even when Docker HEALTHCHECK passed. The old
    // container must still be retained through that outer Compose gate.
    const httpFailureCommand = `mkdir -p /tmp/www/cgi-bin && echo candidate > /tmp/www/index.html && printf '%s\n' '#!/bin/sh' 'printf "Status: 503 Service Unavailable\\r\\nContent-Type: text/plain\\r\\n\\r\\nunready"' > /tmp/www/cgi-bin/unready && chmod +x /tmp/www/cgi-bin/unready && exec httpd -f -p 3000 -h /tmp/www`;
    await repos.project.update(projectId, {
      readiness: {
        preflight: true,
        stabilizationSeconds: 15,
        enabled: true,
        path: "/cgi-bin/unready",
        port: 3000,
        timeoutSeconds: 2,
        onFailure: "fail",
      },
    });
    await repos.service.update(svc.id, { command: httpFailureCommand, advanced: { healthcheck } });
    const httpFailure = await attempt();
    expect(httpFailure.status).toBe("failed");
    expect(httpFailure.error).toMatch(/never answered|500/);
    expect(await runtime.listProjectContainerIds(projectId)).toEqual([incumbent.containerId]);
    expect(await readEventually(url)).toBe("incumbent\n");
    await repos.project.update(projectId, {
      readiness: { preflight: true, stabilizationSeconds: 15 },
    });

    await repos.service.update(svc.id, {
      command: command.replace("incumbent", "replacement"),
      advanced: { healthcheck },
    });
    const healthy = await attempt();
    expect(healthy.status).toBe("ready");
    const ids = await runtime.listProjectContainerIds(projectId);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(incumbent.containerId);
    expect(await readEventually(url)).toBe("replacement\n");
  });
});
