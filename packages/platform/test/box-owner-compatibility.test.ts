import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  config: { OPENSHIP_HOST_ORGANIZATION_ID: undefined as string | undefined },
  founder: vi.fn(), organization: vi.fn(), membership: vi.fn(), resolves: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: {
  user: { findFoundingAdmin: mocks.founder },
  organization: { findById: mocks.organization }, member: { find: mocks.membership },
} }));
vi.mock("../src/engine/config/env", () => ({ env: mocks.config }));
vi.mock("../src/engine/lib/self-host", () => ({ resolvesToLocalHost: mocks.resolves }));
import { boxOwningOrgId, clearBoxOwningOrgCache, isLocalHostRow } from "../src/engine/lib/box-org";
describe("explicit legacy workspace ownership", () => {
  beforeEach(() => {
    clearBoxOwningOrgCache(); vi.clearAllMocks(); mocks.config.OPENSHIP_HOST_ORGANIZATION_ID = undefined;
    mocks.founder.mockResolvedValue({ id: "founder" }); mocks.organization.mockResolvedValue({ id: "legacy" });
    mocks.membership.mockResolvedValue({ userId: "founder", role: "owner" }); mocks.resolves.mockReturnValue(true);
  });
  it("keeps the founding personal workspace as the default", async () => {
    expect(await boxOwningOrgId()).toBe("org_founder"); expect(mocks.membership).not.toHaveBeenCalled();
  });
  it("accepts an operator-pinned legacy workspace owned by that same founder", async () => {
    mocks.config.OPENSHIP_HOST_ORGANIZATION_ID = "legacy";
    expect(await boxOwningOrgId()).toBe("legacy"); expect(mocks.membership).toHaveBeenCalledWith("legacy", "founder");
    expect(await isLocalHostRow({ organizationId: "legacy", sshHost: "127.0.0.1" })).toBe(true);
    expect(await isLocalHostRow({ organizationId: "other", sshHost: "127.0.0.1" })).toBe(false);
  });
  for (const role of ["admin", "member", null]) it(`rejects a pinned workspace when the founder is ${role}`, async () => {
    mocks.config.OPENSHIP_HOST_ORGANIZATION_ID = "legacy";
    mocks.membership.mockResolvedValue(role ? { role } : null);
    await expect(boxOwningOrgId()).rejects.toMatchObject({ code: "HOST_OWNER_CONFIG_INVALID" });
  });
  it("rejects a missing pinned workspace", async () => {
    mocks.config.OPENSHIP_HOST_ORGANIZATION_ID = "missing"; mocks.organization.mockResolvedValue(null);
    await expect(boxOwningOrgId()).rejects.toMatchObject({ code: "HOST_OWNER_CONFIG_INVALID" });
  });
  it("does not memoize invalid ownership and rechecks after restore", async () => {
    mocks.config.OPENSHIP_HOST_ORGANIZATION_ID = "legacy"; mocks.membership.mockResolvedValue(null);
    await expect(boxOwningOrgId()).rejects.toMatchObject({ code: "HOST_OWNER_CONFIG_INVALID" });
    mocks.membership.mockResolvedValue({ role: "owner" }); expect(await boxOwningOrgId()).toBe("legacy");
    clearBoxOwningOrgCache(); mocks.membership.mockResolvedValue(null);
    await expect(boxOwningOrgId()).rejects.toMatchObject({ code: "HOST_OWNER_CONFIG_INVALID" });
  });
  it("revokes a legacy host workspace as soon as the founder loses ownership", async () => {
    mocks.config.OPENSHIP_HOST_ORGANIZATION_ID = "legacy";
    expect(await boxOwningOrgId()).toBe("legacy");
    mocks.membership.mockResolvedValue({ role: "member" });
    await expect(boxOwningOrgId()).rejects.toMatchObject({ code: "HOST_OWNER_CONFIG_INVALID" });
  });
});
