import { describe, expect, it } from "vitest";
import { resolveUpdateState, customRuntimeUpdatePolicy } from "../src/updates";
describe("verified custom runtime update policy", () => {
  const current = "0.8.0-magic.234d8a9d0bd5";
  const release = (version: string) => ({ version, tag: `v${version}`, notes: "" });
  it("does not mistake the same official baseline for an upgrade", () => {
    expect(resolveUpdateState({ currentVersion: current, latestRelease: release("0.8.0"), mode: "selfhosted", manifest: null })).toMatchObject({ updateAvailable: false, customRuntime: true, adaptationRequired: false });
  });
  it("marks a newer upstream version as awaiting adaptation", () => {
    expect(resolveUpdateState({ currentVersion: current, latestRelease: release("0.9.0"), mode: "selfhosted", manifest: null })).toMatchObject({ updateAvailable: false, customRuntime: true, adaptationRequired: true });
  });
  it("keeps a critical security notice even when notifications are muted", () => {
    const advisory = { id: "critical", title: "Critical fix", message: "Read the advisory", severity: "critical" as const, announce: true, affects: ">=0.7.0 <0.9.0", modes: ["selfhosted" as const], action: { kind: "update" as const, label: "Update" } };
    const result = resolveUpdateState({ currentVersion: current, latestRelease: release("0.9.0"), mode: "selfhosted", manifest: { advisories: [advisory] }, muted: true });
    expect(result.advisories).toEqual([advisory]);
    expect(result.updateAvailable).toBe(false);
  });
  it("leaves ordinary upstream installations on their existing policy", () => {
    expect(customRuntimeUpdatePolicy("0.8.0", "0.9.0")).toBeNull();
    expect(resolveUpdateState({ currentVersion: "0.8.0", latestRelease: release("0.9.0"), mode: "selfhosted", manifest: null }).updateAvailable).toBe(true);
  });
});
