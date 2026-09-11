import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const h = vi.hoisted(() => ({
  allowed: true,
  cancel: vi.fn(),
  permission: vi.fn(),
}));

vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({
    userId: "ci-owner",
    organizationId: "org-1",
    tokenScope: { tokenId: "ci-project-write" },
  }),
}));
vi.mock("../../lib/permission", () => ({ permission: { assert: h.permission } }));
vi.mock("./build.service", () => ({ cancelBuildSession: h.cancel }));
vi.mock("./deployment.service", () => ({}));
vi.mock("./reconcile.service", () => ({}));
vi.mock("./build-status.service", () => ({}));
vi.mock("./ssl.service", () => ({}));
vi.mock("./prepare.service", () => ({}));
vi.mock("../../lib/cloud/project-router", () => ({}));
vi.mock("../projects/transfer.service", () => ({}));

import { cancel } from "./deployment.controller";

function app() {
  const api = new Hono();
  api.post("/deployments/:id/cancel", cancel);
  return api;
}

describe("deployment cancellation with project write access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.allowed = true;
    h.permission.mockImplementation(async (_context, grant) => {
      // A dedicated project read/write credential cannot satisfy admin.
      if (!h.allowed || grant.resourceId !== "dep-owned" || grant.action !== "write")
        throw new HTTPException(404);
    });
    h.cancel.mockResolvedValue({ success: true, pending: false });
  });

  it("lets the same write credential that starts a deployment cancel it", async () => {
    const response = await app().request("/deployments/dep-owned/cancel", { method: "POST" });
    expect(response.status).toBe(200);
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith("dep-owned");
    expect(h.permission).toHaveBeenCalledWith(expect.anything(), {
      resourceType: "deployment",
      resourceId: "dep-owned",
      action: "write",
    });
  });

  it.each(["dep-other-project", "dep-owned"])(
    "does not touch a worker when permission denies %s",
    async (id) => {
      h.allowed = false;
      const response = await app().request(`/deployments/${id}/cancel`, { method: "POST" });
      expect(response.status).toBe(404);
      expect(h.cancel).not.toHaveBeenCalled();
    },
  );

  it("keeps cancellation pending until the worker has stopped", async () => {
    h.cancel.mockResolvedValue({ success: true, pending: true });
    const response = await app().request("/deployments/dep-owned/cancel", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true, pending: true });
  });
});
