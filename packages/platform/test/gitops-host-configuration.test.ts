import { describe, expect, it, vi } from "vitest";
import { inspectBoundHostConfiguration } from "../src/gitops-host-configuration";

const root = "/root/magic-deploy-config-runtime/core-config/aaaaaaaaaaaaaaaa";
const digest = "a".repeat(64);
describe("bound Core configuration staging layout", () => {
  it("reads flat host paths and preserves repository keys in the frozen configuration identity", async () => {
    const files = { "stacks/magic-core/deploy/nginx.conf": digest, "stacks/magic-core/deploy/grafana/grafana.ini": digest };
    const read = vi.fn(async (_root: string, paths: string[]) => {
      if (paths.some(path => !["nginx.conf", "grafana/grafana.ini"].includes(path))) throw new Error("File unavailable in flat staged root");
      return Object.fromEntries(paths.map(path => [path, digest]));
    });
    expect(await inspectBoundHostConfiguration({ inspectReleaseHostConfiguration: read }, "magic-core", { root, files })).toEqual(files);
    expect(read).toHaveBeenCalledWith(root, ["nginx.conf", "grafana/grafana.ini"]);
  });
  it.each(["../nginx.conf", "stacks/magic-core/deploy/../outside", "stacks/magic-core/deploy//nginx.conf", "stacks/other/deploy/nginx.conf", "nginx.conf"])("rejects an unbound repository path %s before host reads", async path => {
    const read = vi.fn();
    await expect(inspectBoundHostConfiguration({ inspectReleaseHostConfiguration: read }, "magic-core", { root, files: { [path]: digest } })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects another stack, a mutable root or incomplete host hashes", async () => {
    const read = vi.fn(async () => ({}));
    const config = { root, files: { "stacks/magic-core/deploy/nginx.conf": digest } };
    await expect(inspectBoundHostConfiguration({ inspectReleaseHostConfiguration: read }, "admin", config)).rejects.toThrow();
    await expect(inspectBoundHostConfiguration({ inspectReleaseHostConfiguration: read }, "magic-core", { ...config, root: root + "/../new" })).rejects.toThrow();
    await expect(inspectBoundHostConfiguration({ inspectReleaseHostConfiguration: read }, "magic-core", config)).rejects.toThrow();
  });
});
