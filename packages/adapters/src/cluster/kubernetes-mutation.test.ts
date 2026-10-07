import { describe, expect, it, vi } from "vitest";
import { KubernetesApiError, type KubernetesApi } from "./kubernetes-api";
import { deleteKubernetesObject, patchKubernetesObject } from "./kubernetes-mutation";

describe("Kubernetes optimistic mutations", () => {
  it("never repeats a delete after a lost response or touches a replacement object", async () => {
    for (const replaced of [false, true]) {
      let reads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "GET")
          return {
            metadata: { uid: ++reads === 1 ? "original" : "replacement", resourceVersion: "1" },
          };
        throw replaced ? new KubernetesApiError(409, "status changed") : new Error("response lost");
      });
      await expect(
        deleteKubernetesObject(
          { request } as unknown as KubernetesApi,
          "/resource",
          "original",
          async () => {},
        ),
      ).rejects.toThrow(replaced ? /replaced/ : /response lost/);
      expect(request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    }
  });
  it("rechecks ownership and the operation fence on every explicit delete conflict", async () => {
    let owned = true;
    const request = vi.fn(async (method: string) => {
      if (method === "GET")
        return {
          metadata: {
            uid: "original",
            resourceVersion: "2",
            labels: { owner: owned ? "ours" : "another" },
          },
        };
      owned = false;
      throw new KubernetesApiError(409, "status changed");
    });
    const validate = vi.fn((current) => {
      if (current.metadata.labels?.owner !== "ours") throw Error("ownership changed");
    });
    await expect(
      deleteKubernetesObject(
        { request } as unknown as KubernetesApi,
        "/resource",
        "original",
        validate,
      ),
    ).rejects.toThrow(/ownership changed/);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("does not replay an accepted deletion or delete without a known identity", async () => {
    const request = vi.fn(async () => ({
      metadata: { uid: "original", resourceVersion: "2", deletionTimestamp: "now" },
    }));
    await deleteKubernetesObject(
      { request } as unknown as KubernetesApi,
      "/resource",
      "original",
      async () => {},
    );
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      deleteKubernetesObject(
        { request } as unknown as KubernetesApi,
        "/resource",
        undefined,
        async () => {},
      ),
    ).rejects.toThrow(/identity/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("bounds repeated explicit delete conflicts", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "GET") return { metadata: { uid: "original", resourceVersion: "2" } };
      throw new KubernetesApiError(409, "still changing");
    });
    await expect(
      deleteKubernetesObject(
        { request } as unknown as KubernetesApi,
        "/resource",
        "original",
        async () => {},
      ),
    ).rejects.toThrow(/still changing/);
    expect(request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(5);
  });
  it("re-reads and revalidates after a controller changes resourceVersion", async () => {
    let version = 1;
    const request = vi.fn(async (method: string, _path: string, body?: any) => {
      if (method === "GET") return { metadata: { uid: "owned", resourceVersion: String(version) } };
      if (version++ === 1) throw new KubernetesApiError(409, "status changed");
      expect(body.metadata).toEqual({ uid: "owned", resourceVersion: "2" });
      return body;
    });
    const validate = vi.fn(() => ({ spec: { replicas: 3 } }));
    await patchKubernetesObject({ request } as unknown as KubernetesApi, "/resource", validate);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not replay an ambiguous request or overwrite a replacement resource", async () => {
    for (const replaced of [false, true]) {
      let reads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "GET")
          return {
            metadata: { uid: ++reads === 1 ? "original" : "replacement", resourceVersion: "1" },
          };
        throw replaced ? new KubernetesApiError(409, "changed") : new Error("connection lost");
      });
      await expect(
        patchKubernetesObject({ request } as unknown as KubernetesApi, "/resource", () => ({
          spec: {},
        })),
      ).rejects.toThrow(replaced ? /replaced/ : /connection lost/);
      expect(request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
    }
  });
});
