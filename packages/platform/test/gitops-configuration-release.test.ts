import { describe, expect, it } from "vitest";
import { configurationReleaseScope } from "../src/gitops-release-scope";

describe("explicit PRT configuration release", () => {
  const input = { environment: "preview", services: ["web"], applications: ["web"], tasks: [] as string[] };
  it("recreates only the named application without inventing an image event", () => {
    expect(configurationReleaseScope(input)).toEqual(["web"]);
  });
  it("rejects production, empty or duplicate scope, infrastructure and completion tasks", () => {
    for (const change of [{ environment: "production" }, { services: [] }, { services: ["web", "web"] },
      { services: ["postgres"] }, { tasks: ["web"] }]) {
      expect(() => configurationReleaseScope({ ...input, ...change })).toThrow();
    }
  });
});
