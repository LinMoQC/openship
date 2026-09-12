import { describe, expect, it } from "vitest";
import { composeDeployResultStatus } from "./deploy-result-status";

describe("composeDeployResultStatus", () => {
  it("does not publish a release when every selected live service failed", () => {
    expect(
      composeDeployResultStatus({
        successful: 14,
        failed: 2,
        services: [
          ...Array.from({ length: 14 }, () => ({ status: "running", carried: true as const })),
          { status: "failed" },
          { status: "failed" },
        ],
      }),
    ).toBe("failed");
  });

  it("does not publish a release when only the migration task succeeded", () => {
    expect(
      composeDeployResultStatus({
        successful: 15,
        failed: 1,
        services: [
          ...Array.from({ length: 14 }, () => ({ status: "running", carried: true as const })),
          { status: "completed", containerId: "migration-task", runToCompletion: true as const },
          { status: "failed" },
        ],
      }),
    ).toBe("failed");
  });

  it("keeps partial live-service deployment semantics for a real mixed cutover", () => {
    expect(
      composeDeployResultStatus({
        successful: 2,
        failed: 1,
        services: [
          { status: "running", carried: true },
          { status: "running", containerId: "new-api" },
          { status: "failed" },
        ],
      }),
    ).toBe("ready");
  });
});
