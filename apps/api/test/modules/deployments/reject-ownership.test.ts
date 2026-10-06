import { describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import { seedOrg, seedProject, seedDeployment, seedService, setActive } from "../../helpers/seed";

const h = vi.hoisted(() => ({ rollback: vi.fn(), cleanup: vi.fn() }));
vi.mock("@repo/platform/engine/modules/deployments/rollback/index", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  rollback: h.rollback,
}));
vi.mock("@repo/platform/engine/modules/projects/project-cleanup.service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  executeCleanup: h.cleanup,
}));

const { rejectDeployment } =
  await import("@repo/platform/engine/modules/deployments/deployment.service");
const { computeCleanupKeepSet } =
  await import("@repo/platform/engine/modules/projects/cleanup-keep-set");

describe("rollback predecessor ownership", () => {
  it("leaves an already-active predecessor running without scheduling another deployment", async () => {
    h.rollback.mockClear(); h.cleanup.mockClear();
    const org = await seedOrg(), project = await seedProject(org.organizationId);
    const previous = await seedDeployment(project);
    await setActive(project.id, previous.id);
    const candidate = await seedDeployment(project, { status: "partial_failure",
      meta: { previousActiveDeploymentId: previous.id, strictServiceScope: true, targetServiceIds: ["unknown-but-not-restored"] } });
    await rejectDeployment(candidate.id, org.organizationId);
    expect(h.rollback).not.toHaveBeenCalled();
    expect((await repos.project.findById(project.id))?.activeDeploymentId).toBe(previous.id);
    expect((await repos.deployment.findById(candidate.id))?.status).toBe("rejected");
  });
  it("passes the exact service scope to restoration when the candidate became active", async () => {
    h.rollback.mockClear(); h.cleanup.mockClear();
    const org = await seedOrg(), project = await seedProject(org.organizationId);
    const service = await seedService(project.id, { name: "relay" });
    const previous = await seedDeployment(project);
    const candidate = await seedDeployment(project, { meta: { previousActiveDeploymentId: previous.id,
      strictServiceScope: true, targetServiceIds: [service.id] } });
    await setActive(project.id, candidate.id);
    await rejectDeployment(candidate.id, org.organizationId);
    expect(h.rollback).toHaveBeenCalledExactlyOnceWith(previous.id, { serviceIds: [service.id], strictServiceScope: true });
  });
  it.each([false, true])(
    "refuses a predecessor from another project (different organization: %s) before any runtime action",
    async (differentOrg) => {
      h.rollback.mockClear();
      h.cleanup.mockClear();
      const org = await seedOrg();
      const otherOrg = differentOrg ? await seedOrg() : org;
      const project = await seedProject(org.organizationId, { rollbackWindow: 0 });
      const otherProject = await seedProject(otherOrg.organizationId);
      const foreign = await seedDeployment(otherProject, {
        containerId: "foreign-container",
        imageRef: "foreign:image",
      });
      const rejected = await seedDeployment(project, {
        meta: { previousActiveDeploymentId: foreign.id },
      });

      await expect(rejectDeployment(rejected.id, org.organizationId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(h.rollback).not.toHaveBeenCalled();
      expect(h.cleanup).not.toHaveBeenCalled();
      expect((await repos.deployment.findById(rejected.id))?.status).toBe("ready");
      expect((await repos.deployment.findById(foreign.id))?.status).toBe("ready");

      const keep = await computeCleanupKeepSet(project, { alsoProtectDeploymentId: foreign.id });
      expect(keep.containers.has("foreign-container")).toBe(false);
      expect(keep.images.has("foreign:image")).toBe(false);
    },
  );
});
