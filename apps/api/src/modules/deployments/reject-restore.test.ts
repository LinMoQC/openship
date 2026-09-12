import { describe, expect, it } from "vitest";
import { planRejectRestore } from "./reject-restore";

describe("reject restore planning", () => {
  it("does nothing when a failed candidate left its predecessor active", () => {
    expect(
      planRejectRestore({
        deploymentId: "dep-failed",
        previousDeploymentId: "dep-live",
        activeDeploymentId: "dep-live",
        targetServiceIds: ["svc-migrate", "svc-api"],
        strictServiceScope: true,
      }),
    ).toBeNull();
  });

  it("restores a rejected exclusive candidate through its exact service scope", () => {
    expect(
      planRejectRestore({
        deploymentId: "dep-candidate",
        previousDeploymentId: "dep-live",
        activeDeploymentId: "dep-candidate",
        targetServiceIds: ["svc-relay", "svc-relay"],
        strictServiceScope: true,
      }),
    ).toEqual({
      deploymentId: "dep-live",
      scope: { serviceIds: ["svc-relay"], strictServiceScope: true },
    });
  });

  it("preserves whole-release restore semantics for legacy candidates", () => {
    expect(
      planRejectRestore({
        deploymentId: "dep-candidate",
        previousDeploymentId: "dep-live",
        activeDeploymentId: "dep-candidate",
      }),
    ).toEqual({ deploymentId: "dep-live" });
  });
});
