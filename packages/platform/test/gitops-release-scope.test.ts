import { describe, expect, it } from "vitest";
import { productionReleaseScope, runtimeScopeCheck } from "../src/gitops-release-scope";

const services = [
  { name: "platform-api", deployServices: ["platform-api"], deployServicesWithMigration: ["migrate", "platform-api"] },
  { name: "gateway" },
  { name: "interview-agent" },
];
const image = (digest: string, migrationsChanged = false) => ({ digest, migrationsChanged });

describe("production release scope", () => {
  it("adds moved and new infrastructure to the moved application services", () => {
    const deployed = { services: { "platform-api": image("a"), gateway: image("g") }, infrastructure: { "magic-postgres": image("p1"), nginx: image("n") } };
    const target = { services: { "platform-api": image("b", true), gateway: image("g"), "interview-agent": image("i") }, infrastructure: { "magic-postgres": image("p2"), nginx: image("n"), redpanda: image("r") } };
    expect(productionReleaseScope(services, deployed, target)).toEqual(["interview-agent", "magic-postgres", "migrate", "platform-api", "redpanda"]);
  });
  it("is empty when nothing moved", () => {
    const m = { services: { "platform-api": image("a"), gateway: image("g"), "interview-agent": image("i") }, infrastructure: { nginx: image("n") } };
    expect(productionReleaseScope(services, m, m)).toEqual([]);
  });
});

describe("runtime service scope", () => {
  const expected = ["gateway", "magic-postgres", "redpanda", "redpanda-init"];
  it("passes an exact set", () => {
    expect(runtimeScopeCheck(expected, expected, [])).toEqual({ status: "pass", added: [] });
  });
  it("lets a release add declared services it deploys itself", () => {
    expect(runtimeScopeCheck(["gateway", "magic-postgres"], expected, ["gateway", "redpanda", "redpanda-init"])).toEqual({ status: "pass", added: ["redpanda", "redpanda-init"] });
  });
  it("blocks a missing service the release would not deploy", () => {
    expect(runtimeScopeCheck(["gateway", "magic-postgres"], expected, ["redpanda"]).status).toBe("fail");
  });
  it("blocks a row outside the bound set", () => {
    expect(runtimeScopeCheck([...expected, "legacy"], expected, expected).status).toBe("fail");
  });
});
