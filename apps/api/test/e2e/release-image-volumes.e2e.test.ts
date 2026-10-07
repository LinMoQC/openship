import { expect, it } from "vitest";
import Dockerode from "dockerode";
import { randomUUID } from "node:crypto";
import { DockerRuntime } from "@repo/adapters";
import { inspectContainerImage } from "../../../../packages/adapters/src/runtime/release-inspection";
import { checkReleaseTopology } from "../../../../packages/platform/src/gitops-topology";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";
import { GITOPS_POSTGRES_IMAGE } from "../helpers/gitops-test-images";

describeDockerE2E("release attestation of real image-created volumes", () => {
  it("accepts a completed image-only job and rejects requested or inherited anonymous mounts", async () => {
    await requireDocker();
    const runtime = await DockerRuntime.create({ transport: "socket" });
    try { await runtime.pullImage(GITOPS_POSTGRES_IMAGE); } finally { await runtime.dispose(); }
    const docker = new Dockerode({ socketPath: dockerSocketPath });
    const image = await docker.getImage(GITOPS_POSTGRES_IMAGE).inspect();
    const targets = Object.keys(image.Config.Volumes ?? {});
    expect(targets.length).toBeGreaterThan(0);
    const label = randomUUID(), networkName = `openship-volume-attestation-${label}`;
    const network = await docker.createNetwork({ Name: networkName, Labels: { "openship.test": label } });
    const containers: Dockerode.Container[] = [], volumes = new Set<string>();
    const named = `openship-volume-attestation-${label}`;
    try {
      await docker.createVolume({ Name: named, Labels: { "openship.test": label } });
      volumes.add(named);
      async function job(host: Dockerode.HostConfig = {}) {
        const container = await docker.createContainer({
          Image: image.Id, Entrypoint: [], Cmd: ["sh", "-c", "exit 0"],
          Labels: { "openship.project": label, "openship.service": "init", "openship.test": label },
          HostConfig: { NetworkMode: networkName, ...host },
        });
        containers.push(container);
        await container.start();
        expect((await container.wait()).StatusCode).toBe(0);
        const inspected = await container.inspect();
        expect(inspected.Config.Labels["openship.test"]).toBe(label);
        for (const mount of inspected.Mounts) if (mount.Type === "volume" && mount.Name) volumes.add(mount.Name);
        return { container, actual: await inspectContainerImage(docker, container.id, GITOPS_POSTGRES_IMAGE) };
      }
      const service = { ports: [], volumes: [], advanced: { runToCompletion: true, externalNetworkName: networkName } };
      const options = { slug: label, namespaceVolumes: false, containerIds: {} };
      const implicit = await job();
      expect(implicit.actual.mounts.length).toBe(targets.length);
      expect(implicit.actual.implicitImageMounts).toEqual(implicit.actual.mounts);
      expect(checkReleaseTopology(service, implicit.actual, options).status).toBe("pass");
      expect(checkReleaseTopology({ ...service, advanced: { externalNetworkName: networkName } }, implicit.actual, options).status).toBe("fail");
      const requested = await job({ Binds: [`${named}:${targets[0]}`] });
      expect(requested.actual.implicitImageMounts).toEqual([]);
      expect(checkReleaseTopology(service, requested.actual, options).status).toBe("fail");
      const inherited = await job({ VolumesFrom: [implicit.container.id] });
      expect(inherited.actual.implicitImageMounts).toEqual([]);
      expect(checkReleaseTopology(service, inherited.actual, options).status).toBe("fail");
    } finally {
      for (const container of containers) await container.remove({ force: true });
      for (const name of volumes) await docker.getVolume(name).remove();
      await network.remove();
    }
  });
});
