import { beforeEach, describe, expect, it, vi } from "vitest";
import { deployApi } from "@/lib/api/deploy";
import { triggerProjectDeployment } from "./project-deployment";

vi.mock("@/lib/api/deploy", () => ({ deployApi: { trigger: vi.fn() } }));

describe("manual project deployment requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["preview", "production", "development"] as const)(
    "sends the selected %s environment for every redeploy mode",
    async (environmentType) => {
      for (const [mode, flag] of [
        ["smart", "smartRoute"],
        ["all", "forceAll"],
        ["refresh", "refresh"],
      ] as const) {
        await triggerProjectDeployment({ id: "project-prt", environmentType }, mode);
        expect(deployApi.trigger).toHaveBeenLastCalledWith({
          projectId: "project-prt",
          environment: environmentType,
          [flag]: true,
        });
      }
    },
  );

  it("lets the server resolve missing metadata instead of guessing production", async () => {
    await triggerProjectDeployment({ id: "project-prt" });
    expect(deployApi.trigger).toHaveBeenCalledWith({
      projectId: "project-prt",
      environment: undefined,
      smartRoute: true,
    });
  });
});
