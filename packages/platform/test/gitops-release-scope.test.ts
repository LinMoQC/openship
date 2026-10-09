import { describe, expect, it } from "vitest";
import { productionRecoveryScope, productionReleaseScope, runtimeScopeCheck, unacceptedAttemptRecoveryScope } from "../src/gitops-release-scope";

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
  const base = { active: { status: "partial_failure", decision: "pending" as string | null }, activeHash: "h", deployedHash: "h", targetHash: "h" as string, activeConfiguration: "c", targetConfiguration: "c",
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
  it("still resumes the active partial deployment after a newer attempt superseded its decision", () => {
    expect(productionRecoveryScope({ ...base, active: { status: "cancelled", decision: "superseded" } })).toEqual(["gateway", "platform-api", "relay"]);
  });
  it("refuses an active deployment that is not an unfinished partial failure", () => {
    expect(productionRecoveryScope({ ...base, active: { status: "ready", decision: null } })).toEqual([]);
    expect(productionRecoveryScope({ ...base, active: { status: "cancelled", decision: null } })).toEqual([]);
    expect(productionRecoveryScope({ ...base, active: { status: "failed", decision: "superseded" } })).toEqual([]);
  });
});

describe("PRT recovery of an unaccepted attempt", () => {
  // 2026-10-09: a harvester-only release replaced its container, then acceptance
  // failed on an untouched task. The run ended action_required, its ready attempt
  // was never activated and the incumbent no longer described what was running.
  const base = { run: { stage: "action_required", deploymentId: "dep_attempt" }, attempt: { id: "dep_attempt", status: "ready" }, activeId: "dep_incumbent",
    attemptHash: "h", deployedHash: "h", targetHash: "h" as string, attemptConfiguration: "c", targetConfiguration: "c",
    expected: ["gateway", "harvester", "migrate", "redpanda-init"], unconverged: ["harvester"], tasks: ["migrate", "redpanda-init", "legacy-task"] };
  it("rebuilds every service off the target digest plus every bound task", () => {
    expect(unacceptedAttemptRecoveryScope(base)).toEqual(["harvester", "migrate", "redpanda-init"]);
    expect(unacceptedAttemptRecoveryScope({ ...base, run: { stage: "failed", deploymentId: "dep_attempt" }, attempt: { id: "dep_attempt", status: "partial_failure" } })).toEqual(["harvester", "migrate", "redpanda-init"]);
  });
  it("leaves a run that is still active or was accepted alone", () => {
    for (const stage of ["deploying", "verifying", "recovering", "accepted", "restored"])
      expect(unacceptedAttemptRecoveryScope({ ...base, run: { stage, deploymentId: "dep_attempt" } })).toEqual([]);
  });
  it("needs the run's own ready attempt, distinct from the active deployment", () => {
    expect(unacceptedAttemptRecoveryScope({ ...base, run: { stage: "action_required", deploymentId: null } })).toEqual([]);
    expect(unacceptedAttemptRecoveryScope({ ...base, attempt: { id: "dep_other", status: "ready" } })).toEqual([]);
    expect(unacceptedAttemptRecoveryScope({ ...base, activeId: "dep_attempt" })).toEqual([]);
    expect(unacceptedAttemptRecoveryScope({ ...base, attempt: { id: "dep_attempt", status: "failed" } })).toEqual([]);
  });
  it("refuses an attempt of another manifest or configuration", () => {
    expect(unacceptedAttemptRecoveryScope({ ...base, attemptHash: "older" })).toEqual([]);
    expect(unacceptedAttemptRecoveryScope({ ...base, targetHash: "newer" })).toEqual([]);
    expect(unacceptedAttemptRecoveryScope({ ...base, attemptConfiguration: null })).toEqual([]);
  });
  it("is empty when every container already runs the target", () => {
    expect(unacceptedAttemptRecoveryScope({ ...base, unconverged: [] })).toEqual([]);
  });
});
