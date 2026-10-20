import { describe, expect, it } from "vitest";
import { selectedTaskRebuildScope } from "../src/gitops-release-scope";

describe("release preflight for selected completion tasks", () => {
  // The accepted incumbent retained a successful init task, but its exited
  // container was removed later. The next exact release reruns that task.
  const incident = { environment: "preview", action: "release", selected: ["migrate", "platform-api", "redpanda-init"],
    tasks: ["migrate", "redpanda-init"], expected: ["magic-postgres", "platform-api", "redpanda-init"],
    converged: ["magic-postgres", "platform-api"] };

  it("permits rebuilding the selected missing task only when every retained service is proven", () => {
    expect(selectedTaskRebuildScope(incident)).toEqual(["redpanda-init"]);
  });

  it("does not hide an unproven database, application or unselected completion task", () => {
    expect(selectedTaskRebuildScope({ ...incident, converged: ["platform-api"] })).toEqual([]);
    expect(selectedTaskRebuildScope({ ...incident, converged: ["magic-postgres"] })).toEqual([]);
    expect(selectedTaskRebuildScope({ ...incident, selected: ["platform-api"] })).toEqual([]);
    expect(selectedTaskRebuildScope({ ...incident, tasks: [] })).toEqual([]);
  });

  it("allows a production release to rerun its selected missing task while retaining proven services", () => {
    expect(selectedTaskRebuildScope({ ...incident, environment: "production" })).toEqual(["redpanda-init"]);
    expect(selectedTaskRebuildScope({ ...incident, environment: "production", converged: ["platform-api"] })).toEqual([]);
    expect(selectedTaskRebuildScope({ ...incident, environment: "production", selected: ["platform-api"] })).toEqual([]);
  });

  it("leaves unsupported environments, rollback and verification checks unchanged", () => {
    expect(selectedTaskRebuildScope({ ...incident, environment: "development" })).toEqual([]);
    expect(selectedTaskRebuildScope({ ...incident, action: "rollback" })).toEqual([]);
    expect(selectedTaskRebuildScope({ ...incident, action: "verify" })).toEqual([]);
    expect(selectedTaskRebuildScope({ ...incident, selected: [] })).toEqual([]);
  });

  it("needs no repair when every task is already proven", () => {
    expect(selectedTaskRebuildScope({ ...incident, converged: incident.expected })).toEqual([]);
  });
});
