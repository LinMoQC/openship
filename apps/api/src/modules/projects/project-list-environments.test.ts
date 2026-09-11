import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@repo/db", async (original) => {
  const actual = await original<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: { ...actual.repos, project: { ...actual.repos.project, listByOrganization: h.list } },
  };
});
import { listProjects } from "./project-crud.service";
const prod = {
  id: "prod",
  groupId: "web",
  environmentName: "Production",
  environmentSlug: "production",
  createdAt: new Date(0),
};
const prt = {
  ...prod,
  id: "prt",
  environmentName: "PRT",
  environmentSlug: "prt",
  activeDeploymentId: "ready-prt",
};
describe("project list environment visibility", () => {
  beforeEach(() => {
    h.list.mockResolvedValue({ rows: [prod, prt], total: 2 });
  });
  it("keeps siblings available for batched home enrichment", async () => {
    const result = await listProjects("org", { includeEnvironments: true });
    expect(result.rows.map((p) => p.id)).toEqual(["prod"]);
    expect(result.environmentRows?.map((p) => p.id)).toEqual(["prod", "prt"]);
  });
  it("filters scoped grants before choosing the group representative", async () => {
    const result = await listProjects("org", {
      includeEnvironments: true,
      visibleProjectIds: new Set(["prt"]),
    });
    expect(result.rows.map((p) => p.id)).toEqual(["prt"]);
    expect(result.environmentRows?.map((p) => p.id)).toEqual(["prt"]);
  });
  it("keeps environment rows private to callers that explicitly request them", async () => {
    expect((await listProjects("org")).environmentRows).toBeUndefined();
  });
  it("shows Production first regardless of the order returned by storage", async () => {
    h.list.mockResolvedValue({ rows: [prt, prod], total: 2 });
    expect(
      (await listProjects("org", { includeEnvironments: true })).environmentRows?.map((p) => p.id),
    ).toEqual(["prod", "prt"]);
  });
});
