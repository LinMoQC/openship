import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

function runtimeForState(state: Record<string, unknown>) {
  const inspect = vi.fn(async () => ({ State: state }));
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
  (runtime as unknown as { _docker: unknown })._docker = {
    getContainer: vi.fn(() => ({ inspect })),
  };
  return { runtime, inspect };
}

describe("DockerRuntime.waitForServiceCondition", () => {
  it("accepts a running healthy dependency", async () => {
    const { runtime, inspect } = runtimeForState({
      Running: true,
      Health: { Status: "healthy" },
    });

    await expect(runtime.waitForServiceCondition("db", "service_healthy", 10)).resolves.toBe(
      undefined,
    );
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("fails closed when service_healthy has no Docker healthcheck", async () => {
    const { runtime } = runtimeForState({ Running: true });

    await expect(runtime.waitForServiceCondition("db", "service_healthy", 10)).rejects.toThrow(
      "without a healthcheck",
    );
  });

  it("accepts only exit code zero for a completed task", async () => {
    const ok = runtimeForState({ Running: false, ExitCode: 0 }).runtime;
    const failed = runtimeForState({ Running: false, ExitCode: 1 }).runtime;

    await expect(
      ok.waitForServiceCondition("migrate", "service_completed_successfully", 10),
    ).resolves.toBeUndefined();
    await expect(
      failed.waitForServiceCondition("migrate", "service_completed_successfully", 10),
    ).rejects.toThrow("exited with code 1");
  });
});

describe("DockerRuntime.ensureNetwork", () => {
  it("reuses an exact external network and never creates a replacement", async () => {
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
    const createNetwork = vi.fn();
    (runtime as unknown as { _docker: unknown })._docker = {
      listNetworks: vi.fn(async () => [{ Id: "network-existing", Name: "magic-prod_default" }]),
      createNetwork,
    };

    await expect(runtime.ensureNetwork("ignored", "magic-prod_default")).resolves.toBe(
      "network-existing",
    );
    expect(createNetwork).not.toHaveBeenCalled();
  });

  it("fails when a required external network is missing", async () => {
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
    const createNetwork = vi.fn();
    (runtime as unknown as { _docker: unknown })._docker = {
      listNetworks: vi.fn(async () => []),
      createNetwork,
    };

    await expect(runtime.ensureNetwork("ignored", "missing-network")).rejects.toThrow(
      "does not exist",
    );
    expect(createNetwork).not.toHaveBeenCalled();
  });
});
