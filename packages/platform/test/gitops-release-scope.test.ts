import { describe, expect, it } from "vitest";
import { productionRecoveryScope, productionReleaseScope, runtimeScopeCheck } from "../src/gitops-release-scope";

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

describe("production recovery scope", () => {
  const base = { activeStatus: "partial_failure", activeHash: "h", deployedHash: "h", targetHash: "h" as string, activeConfiguration: "c", targetConfiguration: "c",
    expected: ["gateway", "migrate", "nginx", "platform-api", "relay"], unconverged: ["relay", "platform-api", "gateway", "relay"], tasks: [] as string[] };
  it("rebuilds only the unconverged bound services of the unfinished revision", () => {
    expect(productionRecoveryScope(base)).toEqual(["gateway", "platform-api", "relay"]);
  });
  it("reruns bound completion tasks, whose proof the partial deployment cannot provide", () => {
    expect(productionRecoveryScope({ ...base, tasks: ["migrate", "legacy-task"] })).toEqual(["gateway", "migrate", "platform-api", "relay"]);
  });
  it("is empty when everything converged, even with tasks", () => {
    expect(productionRecoveryScope({ ...base, unconverged: [], tasks: ["migrate"] })).toEqual([]);
  });
  it("ignores names outside the bound set", () => {
    expect(productionRecoveryScope({ ...base, unconverged: ["legacy", "nginx"] })).toEqual(["nginx"]);
  });
  it("still resumes when a later failed attempt appended an identical lock commit", () => {
    // Only content is compared: the branch head may be another commit with the same manifest and configuration.
    expect(productionRecoveryScope(base)).toEqual(["gateway", "platform-api", "relay"]);
  });
  it("refuses a target that differs from the deployed manifest", () => {
    expect(productionRecoveryScope({ ...base, targetHash: "other" })).toEqual([]);
  });
  it("refuses a partial failure that attempted another manifest", () => {
    expect(productionRecoveryScope({ ...base, activeHash: "older" })).toEqual([]);
    expect(productionRecoveryScope({ ...base, activeHash: null })).toEqual([]);
  });
  it("refuses a partial failure that attempted another configuration", () => {
    expect(productionRecoveryScope({ ...base, activeConfiguration: "older" })).toEqual([]);
    expect(productionRecoveryScope({ ...base, activeConfiguration: null })).toEqual([]);
  });
  it("refuses an active deployment that is not a partial failure", () => {
    expect(productionRecoveryScope({ ...base, activeStatus: "ready" })).toEqual([]);
  });
});
