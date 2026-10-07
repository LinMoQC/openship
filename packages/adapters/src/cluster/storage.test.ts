import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterStorageAdapter, longhornBase, managedStorageClass } from "./storage";
import { StorageProbe } from "./storage-probe";
import { downloadClusterAddon } from "./database-addons";
import { runClusterJob } from "./job";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";

vi.mock("./database-addons", async (original) => ({
  ...(await original<typeof import("./database-addons")>()),
  downloadClusterAddon: vi.fn(async () => []),
}));
vi.mock("./job", () => ({ runClusterJob: vi.fn(async () => ({})) }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(StorageProbe.prototype, "cleanup").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const shared = managedStorageClass("runtime", 2);
  shared.metadata.uid = "shared-class";
  const local: KubernetesObject = {
    kind: "StorageClass",
    metadata: {
      name: "openship-local",
      uid: "local-class",
      labels: { "openship.io/runtime": "runtime", "openship.io/addon": "local" },
    },
    provisioner: "rancher.io/local-path",
  };
  const custom: KubernetesObject = {
    kind: "StorageClass",
    metadata: {
      name: "custom-storage",
      uid: "custom-class",
      labels: { "openship.io/runtime": "runtime" },
    },
    provisioner: "example.test/driver",
  };
  const objects = new Map(
    [shared, local, custom].map((object) => [
      `/apis/storage.k8s.io/v1/storageclasses/${object.metadata.name}`,
      object,
    ]),
  );
  const request = vi.fn(async (method: string, path: string, body?: any) => {
    if (method === "GET") {
      if (path.startsWith("/apis/storage.k8s.io/v1/storageclasses?"))
        // Kubernetes list entries omit apiVersion/kind; the enclosing list
        // defines their type, unlike a singular resource GET.
        return {
          items: [shared, local, custom].map(({ apiVersion, kind, ...object }) => object),
        };
      if (path === "/api/v1/persistentvolumeclaims" || path === "/api/v1/persistentvolumes")
        return { items: [] };
      const found = objects.get(path);
      if (!found) throw new KubernetesApiError(404, "Missing");
      return found;
    }
    if (method === "DELETE") {
      expect(body.preconditions.uid).toBe(objects.get(path)?.metadata.uid);
      objects.delete(path);
      return {};
    }
    throw new Error("Unexpected storage mutation");
  });
  const api = { request } as unknown as KubernetesApi;
  const adapter = new ClusterStorageAdapter(
    api,
    "runtime",
    {
      replicas: 2,
      disks: [
        { serverId: "one", path: "/var/lib/openship/storage", reservedGiB: 1 },
        { serverId: "two", path: "/var/lib/openship/storage", reservedGiB: 1 },
      ],
    },
    [],
    AbortSignal.timeout(5000),
    async () => {},
  );
  return { adapter, request, objects };
}

describe("shared-storage cleanup boundaries", () => {
  it("does not start an uninstaller when confirmation is missing or was not saved", async () => {
    for (const missing of [false, true]) {
      const { adapter, request, objects } = setup();
      const confirmation = `${longhornBase}/settings/deleting-confirmation-flag`;
      objects.set("/api/v1/namespaces/longhorn-system", {
        metadata: { uid: "namespace", labels: { "openship.io/runtime": "runtime" } },
      });
      objects.set(`${longhornBase}/volumes`, { metadata: {}, items: [] });
      if (!missing)
        objects.set(confirmation, {
          metadata: { uid: "confirmation", resourceVersion: "1" },
          value: "false",
        });
      const actual = request.getMockImplementation()!;
      request.mockImplementation(async (method, path, body) =>
        method === "PATCH" && path === confirmation
          ? { ...objects.get(path)!, value: "true" }
          : actual(method, path, body),
      );
      vi.mocked(runClusterJob).mockClear();
      await expect(adapter.remove(async () => {})).rejects.toThrow(
        missing ? /unavailable/ : /not saved/,
      );
      expect(runClusterJob).not.toHaveBeenCalled();
      expect(request.mock.calls.every(([method]) => method !== "DELETE")).toBe(true);
    }
  });
  it("verifies the uninstall setting and retains the native bounded retry without forcing volumes", async () => {
    const { adapter, request, objects } = setup();
    const namespace = "/api/v1/namespaces/longhorn-system";
    const confirmation = `${longhornBase}/settings/deleting-confirmation-flag`;
    objects.set(namespace, {
      metadata: { uid: "namespace", labels: { "openship.io/runtime": "runtime" } },
    });
    objects.set(`${longhornBase}/volumes`, { metadata: {}, items: [] });
    objects.set(confirmation, {
      metadata: { uid: "confirmation", resourceVersion: "1" },
      value: "false",
    });
    const actual = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, body) => {
      if (method === "PATCH" && path === confirmation) {
        const saved = { ...objects.get(path)!, ...body };
        objects.set(path, saved);
        return saved;
      }
      return actual(method, path, body);
    });
    vi.mocked(downloadClusterAddon).mockImplementation(async (name) =>
      name === "longhorn-uninstall"
        ? [
            {
              apiVersion: "batch/v1",
              kind: "Job",
              metadata: { name: "uninstall", namespace: "longhorn-system" },
              spec: {
                backoffLimit: 1,
                template: {
                  spec: { containers: [{ command: ["longhorn-manager", "uninstall", "--force"] }] },
                },
              },
            },
          ]
        : [],
    );
    await adapter.remove(async () => {});
    expect(objects.get(confirmation)?.value).toBe("true");
    const definition = vi.mocked(runClusterJob).mock.calls[0]![1];
    expect(definition.spec.backoffLimit).toBe(1);
    expect(definition.spec.template.spec.containers[0].command).toEqual([
      "longhorn-manager",
      "uninstall",
    ]);
    const call = request.mock.calls.findIndex(
      ([method, path]) => method === "PATCH" && path === confirmation,
    );
    expect(
      request.mock.calls
        .slice(call + 1)
        .some(([method, path]) => method === "GET" && path === confirmation),
    ).toBe(true);
  });
  it("finishes interrupted cleanup while preserving local database and custom storage classes", async () => {
    const { adapter, request, objects } = setup();
    await adapter.remove(async () => {});
    expect([...objects.values()].map((object) => object.metadata.name)).toEqual([
      "openship-local",
      "custom-storage",
    ]);
    expect(request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("refuses to uninstall while a retained data disk still uses shared storage", async () => {
    const { adapter, request } = setup();
    const actual = request.getMockImplementation()!;
    request.mockImplementation((method, path, body) =>
      path === "/api/v1/persistentvolumes"
        ? Promise.resolve({
            items: [
              {
                metadata: { name: "retained-disk", uid: "retained-disk-uid" },
                spec: { csi: { driver: "driver.longhorn.io" } },
              },
            ],
          })
        : actual(method, path, body),
    );
    await expect(adapter.remove(async () => {})).rejects.toThrow(/retained volumes/);
    expect(downloadClusterAddon).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("keeps an unrelated storage installation untouched", async () => {
    const { adapter, objects, request } = setup();
    objects.set("/api/v1/namespaces/longhorn-system", {
      kind: "Namespace",
      metadata: { name: "longhorn-system", labels: { "openship.io/runtime": "another-runtime" } },
    });
    objects.set(`${longhornBase}/volumes`, { metadata: {}, items: [] });
    await expect(adapter.remove(async () => {})).rejects.toThrow(/ownership/);
    expect(StorageProbe.prototype.cleanup).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
});
