import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  createEnvironment: vi.fn(),
  findGrant: vi.fn(),
  grant: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({
    userId: "user-1",
    organizationId: "org-1",
    tokenScope: { tokenId: "token-1" },
  }),
}));

vi.mock("../../lib/permission", () => ({
  permission: { assert: vi.fn(async () => {}) },
}));

vi.mock("../../lib/audit", () => ({
  audit: { recordAsync: h.audit },
  auditContextFrom: vi.fn(() => ({})),
}));

vi.mock("./project.service", () => ({
  createProjectEnvironment: h.createEnvironment,
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      patGrant: {
        ...actual.repos.patGrant,
        findForResource: h.findGrant,
        createMany: h.grant,
      },
    },
  };
});

import { createEnvironment } from "./project.controller";

function app() {
  const api = new Hono();
  api.post("/projects/:id/environments", createEnvironment);
  return api;
}

describe("create project environment with a scoped PAT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createEnvironment.mockResolvedValue({
      id: "proj_prt-1",
      name: "PRT",
      slug: "prt",
      type: "preview",
      gitBranch: "main",
    });
    h.findGrant.mockResolvedValue({ permissions: ["read", "write"] });
  });

  it("grants the token control of the sibling project it created", async () => {
    const response = await app().request("/projects/proj-prod/environments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentName: "PRT", sourceMode: "manual" }),
    });

    expect(response.status).toBe(201);
    expect(h.findGrant).toHaveBeenCalledWith("token-1", "project", "proj-prod");
    expect(h.grant).toHaveBeenCalledWith("token-1", [
      {
        resourceType: "project",
        resourceId: "proj_prt-1",
        permissions: ["read", "write"],
      },
    ]);
  });
});
