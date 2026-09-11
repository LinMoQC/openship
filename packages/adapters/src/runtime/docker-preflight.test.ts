import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";
import type { MultiServiceDeployConfig } from "./types";

const CONFIG = {
  deploymentId: "dep-new",
  projectId: "proj-demo",
  slug: "demo",
  serviceName: "web",
  image: "example/web@sha256:" + "a".repeat(64),
  imageAlreadyPrepared: true,
  ports: ["127.0.0.1:19082:3000"],
  environment: { PORT: "3000" },
  volumes: [],
  namespaceVolumes: true,
  restart: "unless-stopped",
  advanced: { healthcheck: { test: ["CMD", "true"], interval: "1s", retries: 1 } },
  healthcheckPreflight: { timeoutMs: 1000 },
} satisfies MultiServiceDeployConfig;

async function fixture(
  options: {
    candidateHealth?: string;
    replacementHealth?: string;
    imageVolumes?: object;
    startError?: boolean;
  } = {},
) {
  const events: string[] = [];
  const creates: any[] = [];
  const incumbent = {
    id: "old",
    inspect: vi.fn(async () => ({
      Id: "old",
      State: { Running: true, Health: { Status: "healthy" } },
      Config: { Labels: { "openship.project": "proj-demo" } },
    })),
    stop: vi.fn(async () => {
      events.push("old-stop");
    }),
    start: vi.fn(async () => {
      events.push("old-start");
    }),
    rename: vi.fn(async () => {
      events.push("old-rename");
    }),
    remove: vi.fn(async () => {
      events.push("old-remove");
    }),
  };
  const docker = {
    getImage: () => ({
      inspect: async () => ({
        Id: "sha256:" + "b".repeat(64),
        RepoDigests: [],
        Config: { Volumes: options.imageVolumes },
      }),
    }),
    getContainer: () => incumbent,
    createContainer: vi.fn(async (args: any) => {
      creates.push(args);
      const candidate = args.name !== "openship-demo-web";
      const label = candidate ? "candidate" : "replacement";
      events.push(label + "-create");
      return {
        id: label,
        start: vi.fn(async () => {
          events.push(label + "-start");
          if (!candidate && options.startError) throw new Error("bind failed");
        }),
        remove: vi.fn(async () => {
          events.push(label + "-remove");
        }),
        inspect: vi.fn(async () => {
          events.push(label + "-inspect");
          return {
            State: {
              Running: true,
              Health: {
                Status:
                  (candidate ? options.candidateHealth : options.replacementHealth) ?? "healthy",
              },
            },
            RestartCount: 0,
            NetworkSettings: { Networks: {} },
            Config: {},
          };
        }),
      };
    }),
  };
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = docker;
  return { runtime, incumbent, creates, events };
}

describe("opt-in stateless service health preflight", () => {
  it("rejects an unhealthy candidate without stopping or removing the serving container", async () => {
    const f = await fixture({ candidateHealth: "unhealthy" });
    await expect(f.runtime.deployServiceWorkload({ id: "net-demo" }, CONFIG)).rejects.toThrow(
      /unhealthy/,
    );
    expect(f.incumbent.stop).not.toHaveBeenCalled();
    expect(f.incumbent.remove).not.toHaveBeenCalled();
    expect(f.events).toContain("candidate-remove");
    expect(f.events).not.toContain("replacement-create");
  });

  it("isolates the candidate and retains the old container until the replacement is healthy", async () => {
    const f = await fixture();
    const result = await f.runtime.deployServiceWorkload({ id: "net-demo" }, CONFIG);
    expect(f.incumbent.remove).not.toHaveBeenCalled();
    await result.activation!.commit();
    expect(f.creates).toHaveLength(2);
    const [candidate, replacement] = f.creates;
    expect(candidate.HostConfig.PortBindings).toEqual({});
    expect(candidate.HostConfig.RestartPolicy).toEqual({ Name: "no" });
    expect(candidate.NetworkingConfig.EndpointsConfig["net-demo"].Aliases).not.toContain("web");
    expect(candidate.Env).toEqual(replacement.Env);
    expect(candidate.Image).toEqual(replacement.Image);
    expect(replacement.HostConfig.PortBindings["3000/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "19082" },
    ]);
    expect(f.events.indexOf("candidate-remove")).toBeLessThan(f.events.indexOf("old-stop"));
    expect(f.events.indexOf("replacement-inspect")).toBeLessThan(f.events.indexOf("old-remove"));
  });

  it("retains the incumbent until outer gates finish and can roll back after healthy start", async () => {
    const f = await fixture();
    const result = await f.runtime.deployServiceWorkload({ id: "net-demo" }, CONFIG);
    expect(f.incumbent.remove).not.toHaveBeenCalled();
    await result.activation!.rollback();
    expect(f.incumbent.start).toHaveBeenCalledOnce();
    await result.activation!.rollback();
    expect(f.incumbent.start).toHaveBeenCalledOnce();
  });

  it.each([{ replacementHealth: "unhealthy" }, { startError: true }])(
    "restores the same incumbent when activation fails: %j",
    async (options) => {
      const f = await fixture(options);
      await expect(f.runtime.deployServiceWorkload({ id: "net-demo" }, CONFIG)).rejects.toThrow();
      expect(f.incumbent.remove).not.toHaveBeenCalled();
      expect(f.incumbent.start).toHaveBeenCalledOnce();
      expect(f.events.indexOf("replacement-remove")).toBeLessThan(f.events.indexOf("old-start"));
      expect(f.incumbent.rename).toHaveBeenLastCalledWith({ name: "openship-demo-web" });
    },
  );

  it.each([
    { volumes: ["data:/data"] },
    { namespaces: { network: "container:other" } },
    { advanced: { healthcheck: { disable: true } } },
  ])("refuses unsupported preflight before any container mutation: %j", async (overrides) => {
    const f = await fixture();
    await expect(
      f.runtime.deployServiceWorkload({ id: "net-demo" }, { ...CONFIG, ...overrides }),
    ).rejects.toThrow(/preflight/i);
    expect(f.events).toEqual([]);
  });

  it("refuses image-declared anonymous volumes", async () => {
    const f = await fixture({ imageVolumes: { "/data": {} } });
    await expect(f.runtime.deployServiceWorkload({ id: "net-demo" }, CONFIG)).rejects.toThrow(
      /volume/i,
    );
    expect(f.events).toEqual([]);
  });

  it("does not mutate containers when cancelled before preflight", async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      f.runtime.deployServiceWorkload(
        { id: "net-demo" },
        { ...CONFIG, healthcheckPreflight: { timeoutMs: 1000, signal: abort.signal } },
      ),
    ).rejects.toThrow("cancelled");
    expect(f.events).toEqual([]);
  });

  it("times out health=starting and cleans up without touching the incumbent", async () => {
    const f = await fixture({ candidateHealth: "starting" });
    await expect(
      f.runtime.deployServiceWorkload(
        { id: "net-demo" },
        { ...CONFIG, healthcheckPreflight: { timeoutMs: 1 } },
      ),
    ).rejects.toThrow(/timed out/i);
    expect(f.events).toContain("candidate-remove");
    expect(f.incumbent.stop).not.toHaveBeenCalled();
  });
});
