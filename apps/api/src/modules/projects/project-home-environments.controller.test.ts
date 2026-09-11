import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const h = vi.hoisted(() => ({
  list: vi.fn(),
  enrich: vi.fn(),
  grants: vi.fn(),
  latest: vi.fn(),
  primaries: vi.fn(),
  services: vi.fn(),
  stats: vi.fn(),
}));
vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({
    userId: "user",
    organizationId: "org",
    tokenScope: { tokenId: "ci" },
  }),
}));
vi.mock("../../lib/favicon-detector", () => ({ refreshProjectFaviconIfStale: vi.fn() }));
vi.mock("./project.service", () => ({
  listProjects: h.list,
  enrichProjectsBatch: h.enrich,
  deploymentIsBlocked: () => false,
}));
vi.mock("@repo/db", async (original) => {
  const actual = await original<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      patGrant: { ...actual.repos.patGrant, listByToken: h.grants },
      deployment: {
        ...actual.repos.deployment,
        findLatestByProjects: h.latest,
        statsByProjects: h.stats,
      },
      domain: { ...actual.repos.domain, getPrimariesByProjects: h.primaries },
      service: { ...actual.repos.service, listByProjects: h.services },
    },
  };
});
import { getHome } from "./project.controller";
const prod = {
  id: "prod",
  groupId: "web",
  name: "Commercial Web",
  environmentName: "Production",
  environmentSlug: "production",
  environmentType: "production",
  activeDeploymentId: null,
};
const prt = {
  ...prod,
  id: "prt",
  environmentName: "PRT",
  environmentSlug: "prt",
  environmentType: "preview",
  activeDeploymentId: "dep-prt",
  enabled: true,
  options: { secret: "private-sibling-option" },
};
async function readHome() {
  const app = new Hono();
  app.get("/projects/home", getHome);
  const response = await app.request("/projects/home");
  expect(response.status).toBe(200);
  return response.json();
}
describe("home environment projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.list.mockResolvedValue({ rows: [prod], environmentRows: [prod, prt], total: 1 });
    h.enrich.mockImplementation(async (rows) => rows);
    h.grants.mockResolvedValue(
      ["prod", "prt"].map((resourceId) => ({ resourceType: "project", resourceId })),
    );
    h.latest.mockResolvedValue(new Map([["prt", { id: "dep-prt", status: "ready" }]]));
    h.primaries.mockResolvedValue(new Map());
    h.services.mockResolvedValue(new Map());
    h.stats.mockResolvedValue({ total: 1, success: 1 });
  });
  it("sends both states and links without exposing a sibling's raw configuration", async () => {
    const result = await readHome();
    expect(result).toMatchObject({
      projects: [
        {
          environments: [
            {
              id: "prod",
              name: "Production",
              activeDeploymentId: null,
              latestDeploymentStatus: null,
            },
            {
              id: "prt",
              name: "PRT",
              activeDeploymentId: "dep-prt",
              latestDeploymentStatus: "ready",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private-sibling-option");
    expect(h.enrich).toHaveBeenCalledOnce();
    expect(h.latest).toHaveBeenCalledWith(["prod", "prt"]);
  });
  it("never exposes a sibling outside the token's project grants", async () => {
    h.grants.mockResolvedValue([{ resourceType: "project", resourceId: "prt" }]);
    h.list.mockResolvedValue({ rows: [prt], environmentRows: [prod, prt], total: 1 });
    const result = await readHome();
    expect(result).toMatchObject({ projects: [{ environments: [{ id: "prt" }] }] });
    expect(h.latest).toHaveBeenCalledWith(["prt"]);
    expect(h.list).toHaveBeenCalledWith(
      "org",
      expect.objectContaining({ visibleProjectIds: new Set(["prt"]) }),
    );
  });
});
