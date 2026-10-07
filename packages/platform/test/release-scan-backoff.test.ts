import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../src/context";
const mocks = vi.hoisted(() => ({ state: vi.fn(), project: { id: "p", organizationId: "org", activeDeploymentId: "deployed" } }));
vi.mock("@repo/db", () => ({ repos: { project: { findById: async () => mocks.project }, releases: { bindings: async () => [{ projectId: "p" }] } } }));
vi.mock("../src/engine/lib/active-deployment", () => ({ findActiveDeployment: vi.fn() }));
vi.mock("../src/engine/lib/org-actor", () => ({ resolveOrgOwner: async () => ({ userId: "owner" }) }));
vi.mock("../src/engine/lib/resource-access", () => ({ assertResourceInOrg: vi.fn() }));
vi.mock("../src/engine/lib/authorized-projects", () => ({ listAuthorizedProjects: async () => [mocks.project] }));
vi.mock("../src/engine/lib/platform", () => ({ getPlatformKernel: () => ({ releases: { state: mocks.state } }) }));
vi.mock("../src/engine/modules/releases/release-store", () => ({ releaseStore: { binding: async () => ({ id: "binding" }) } }));
vi.mock("../src/engine/modules/deployments/build.service", () => ({ redeployBuildSession: vi.fn() }));
vi.mock("../src/engine/modules/projects/project-crud.service", () => ({ hasDeployedSide: () => true, evaluateDrift: vi.fn(), resolveUpstreamDrift: vi.fn(), upstreamMatchesSource: vi.fn(), unresolvedUpstreamDrift: vi.fn() }));
import { scanGitopsReleaseStates, scanOrganizationUpdates } from "../src/engine/modules/updates/updates.service";
describe("release scans respect inspection backoff", () => {
  beforeEach(() => { mocks.state.mockReset().mockResolvedValue({ data: {} }); });
  it("background warm-up uses the release freshness and failure deadlines", async () => {
    await scanGitopsReleaseStates();
    expect(mocks.state).toHaveBeenCalledWith(expect.objectContaining({ source: "system", userId: "owner", organizationId: "org" }), "p", { fresh: false });
  });
  it("an explicit authorized scan still requests live state", async () => {
    const ctx = { source: "dashboard", userId: "owner", organizationId: "org" } as ExecutionContext;
    await scanOrganizationUpdates(ctx, "org");
    expect(mocks.state).toHaveBeenCalledWith(ctx, "p", { fresh: true });
  });
});
