import { describe, expect, it, vi } from "vitest";
import { assertRetainedTaskContainer, resolveObservedServiceArtifacts, resolveReleaseServiceArtifacts, untouchedTaskDrift, type ArtifactDeployment, type ArtifactRow } from "../src/gitops-artifacts";

function fixture() {
  const task = { name: "init", image: `docker.io/example/init@sha256:${"a".repeat(64)}`, commandArgv: ["configure"], dependsOn: ["database"], advanced: { runToCompletion: true }, environment: {}, volumes: [] };
  const database = { name: "database", image: `docker.io/example/database@sha256:${"b".repeat(64)}`, dependsOn: [], environment: {} };
  const current: ArtifactDeployment = { id: "current", projectId: "project", organizationId: "org", environment: "preview", status: "ready", commitSha: "c".repeat(40), createdAt: new Date("2026-10-05"), meta: { runtimeMode: "docker", targetServiceIds: ["app"], composeServices: [task, database] } };
  const origin: ArtifactDeployment = { ...current, id: "origin", commitSha: "d".repeat(40), createdAt: new Date("2026-10-03"), meta: { runtimeMode: "docker", targetServiceIds: ["init", "db"], composeServices: structuredClone([task, database]) } };
  const services = [{ id: "init", name: "init", projectId: "project", advanced: { runToCompletion: true } }, { id: "app", name: "app", projectId: "project", advanced: {} }];
  const row: ArtifactRow = { deploymentId: "current", serviceId: "init", serviceName: "init", containerId: null, imageRef: null, status: "skipped", createdAt: current.createdAt };
  const historic: ArtifactRow = { ...row, deploymentId: "origin", status: "success", containerId: "original-container", imageRef: task.image, createdAt: origin.createdAt };
  const reader = { listByService: vi.fn(async () => [row, historic]), deployment: vi.fn(async () => origin) };
  return { current, origin, services, rows: [row], historic, reader, task, database };
}

describe("retained successful one-shot task attestation", () => {
  it("resolves a deliberately skipped task from its exact recorded successful deployment without changing history", async () => {
    const f = fixture();
    const result = await resolveReleaseServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader);
    expect(result[0]).toMatchObject({ containerId: "original-container", sourceDeploymentId: "origin", imageRef: f.task.image });
    expect(f.rows[0]!.containerId).toBeNull();
  });
  it("keeps an active row and never substitutes another container after its runtime inspection fails", async () => {
    const f = fixture(); f.rows[0]!.containerId = "active-container";
    expect((await resolveReleaseServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader))[0]!.containerId).toBe("active-container");
    expect(f.reader.listByService).not.toHaveBeenCalled();
  });
  it("preserves a completed task when parser metadata adds empty environment template keys to it and its dependency", async () => {
    const f = fixture();
    f.origin.meta = { ...f.origin.meta!, composeServices: [structuredClone(f.task), { ...f.database, advanced: {} }] };
    f.current.meta = { ...f.current.meta!, composeServices: [
      { ...f.task, advanced: { ...f.task.advanced, environmentTemplateKeys: [] } },
      { ...f.database, advanced: { environmentTemplateKeys: [] } },
    ] };
    const before = structuredClone(f.rows);
    expect((await resolveReleaseServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader))[0]!.sourceDeploymentId).toBe("origin");
    expect(f.rows).toEqual(before);
  });
  it.each([{ keys: ["DATABASE_URL"] }, { keys: "[]" }, { keys: null }])("rejects nonempty or malformed environment template metadata $keys", async ({ keys }) => {
    const f = fixture();
    f.current.meta = { ...f.current.meta!, composeServices: [{ ...f.task, advanced: { ...f.task.advanced, environmentTemplateKeys: keys } }, f.database] };
    await expect(resolveReleaseServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader)).rejects.toThrow();
  });
  it.each(["project", "organization", "environment", "future", "not-ready", "host", "image", "command", "dependency", "targeted", "unknown-current", "failure-row", "no-current-row", "missing-source"])("rejects %s provenance", async changed => {
    const f = fixture();
    if (changed === "project") f.origin.projectId = "foreign";
    if (changed === "organization") f.origin.organizationId = "foreign";
    if (changed === "environment") f.origin.environment = "production";
    if (changed === "future") f.origin.createdAt = new Date("2026-10-06");
    if (changed === "not-ready") f.origin.status = "failed";
    if (changed === "host") f.origin.meta = { ...f.origin.meta!, serverId: "foreign" };
    if (changed === "image") f.historic.imageRef = "example:latest";
    if (changed === "command") f.origin.meta = { ...f.origin.meta!, composeServices: [{ ...f.task, commandArgv: ["different"] }, f.database] };
    if (changed === "dependency") f.origin.meta = { ...f.origin.meta!, composeServices: [f.task, { ...f.database, environment: { ALTERED: "yes" } }] };
    if (changed === "targeted") f.current.meta = { ...f.current.meta!, targetServiceIds: ["init"] };
    if (changed === "unknown-current") f.current.meta = {};
    if (changed === "failure-row") f.rows[0]!.status = "failure";
    if (changed === "no-current-row") f.rows = [];
    if (changed === "missing-source") f.reader.deployment.mockResolvedValue(undefined);
    await expect(resolveReleaseServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader)).rejects.toThrow();
  });
  it("does not skip over a newer failed attempt to claim an older success", async () => {
    const f = fixture(); f.reader.listByService.mockResolvedValue([{ ...f.historic, status: "failure", containerId: null, createdAt: new Date("2026-10-04") }, f.historic]);
    await expect(resolveReleaseServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader)).rejects.toThrow();
  });
  it("preserves an explicitly untouched task when an unrelated later service deployment failed", async () => {
    const f = fixture();
    const unrelated = { ...f.current, id: "unrelated", status: "failed", createdAt: new Date("2026-10-04") };
    f.reader.listByService.mockResolvedValue([{ ...f.rows[0]!, deploymentId: unrelated.id, createdAt: unrelated.createdAt }, f.historic]);
    f.reader.deployment.mockImplementation(async id => id === unrelated.id ? unrelated : f.origin);
    expect((await resolveReleaseServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader))[0]!.sourceDeploymentId).toBe("origin");
  });
  it("does not borrow a container for an ordinary long-running service", async () => {
    const f = fixture(); f.services[0]!.advanced = {};
    expect((await resolveReleaseServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader))[0]!.containerId).toBeNull();
    expect(f.reader.listByService).not.toHaveBeenCalled();
  });
  it.each(["valid", "project", "service", "deployment", "running", "failed", "command", "entrypoint"])("checks retained runtime %s against its original identity and execution", changed => {
    const f = fixture();
    const actual = { projectId: "project", serviceName: "init", deploymentId: "origin", running: false, exitCode: 0, command: ["configure"], entrypoint: null as string[] | null };
    if (changed === "project") actual.projectId = "foreign";
    if (changed === "service") actual.serviceName = "different";
    if (changed === "deployment") actual.deploymentId = "foreign";
    if (changed === "running") actual.running = true;
    if (changed === "failed") actual.exitCode = 1;
    if (changed === "command") actual.command = ["different"];
    if (changed === "entrypoint") actual.entrypoint = ["other"];
    const verify = () => assertRetainedTaskContainer(f.current, "init", { ...f.historic, sourceDeploymentId: "origin" }, actual);
    if (changed === "valid") expect(verify).not.toThrow(); else expect(verify).toThrow();
  });
});

describe("untouched task drift before a scoped release deploys", () => {
  const compose = (over: Record<string, Record<string, unknown>> = {}) => [
    { name: "redpanda", image: "redpanda@sha256:a", dependsOn: [], commandArgv: ["redpanda", "start"] },
    { name: "redpanda-init", image: "redpanda@sha256:a", dependsOn: ["redpanda"], commandArgv: ["rpk cluster config set"], advanced: { runToCompletion: true } },
    { name: "magic-postgres", image: "pg@sha256:p", dependsOn: [] },
    { name: "migrate", image: "api@sha256:1", dependsOn: ["magic-postgres"], advanced: { runToCompletion: true } },
    { name: "harvester", image: "harvester@sha256:1", dependsOn: ["magic-postgres"] },
  ].map(service => ({ ...service, ...over[service.name] }));
  const tasks = ["migrate", "redpanda-init"];
  it("names a task whose command moved while the release leaves it untouched", () => {
    // The exact 2026-10-09 failure: redpanda-init gained topic creation, harvester shipped alone.
    const target = compose({ "redpanda-init": { commandArgv: ["rpk cluster config set && rpk topic create"] }, harvester: { image: "harvester@sha256:2" } });
    expect(untouchedTaskDrift({ tasks, selected: ["harvester"], incumbent: compose(), target })).toEqual(["redpanda-init"]);
    expect(untouchedTaskDrift({ tasks, selected: ["redpanda-init", "harvester"], incumbent: compose(), target })).toEqual([]);
  });
  it("follows the task's dependencies and the image it shares with its owner", () => {
    // A moved dependency moves the task's tree, even when the dependency itself ships.
    const movedBroker = compose({ redpanda: { image: "redpanda@sha256:b" } });
    expect(untouchedTaskDrift({ tasks, selected: ["redpanda"], incumbent: compose(), target: movedBroker })).toEqual(["redpanda-init"]);
    expect(untouchedTaskDrift({ tasks, selected: ["redpanda", "redpanda-init"], incumbent: compose(), target: movedBroker })).toEqual([]);
    // migrate runs the platform-api image: a release without migrations still moves it.
    expect(untouchedTaskDrift({ tasks, selected: ["platform-api"], incumbent: compose(), target: compose({ migrate: { image: "api@sha256:2" } }) })).toEqual(["migrate"]);
  });
  it("passes unchanged definitions and treats an unknown one as drift", () => {
    expect(untouchedTaskDrift({ tasks, selected: ["harvester"], incumbent: compose(), target: compose({ harvester: { image: "harvester@sha256:2" } }) })).toEqual([]);
    expect(untouchedTaskDrift({ tasks, selected: ["harvester"], incumbent: compose().filter(s => s.name !== "migrate"), target: compose() })).toEqual(["migrate"]);
  });
});

describe("observing an active deployment with an unprovable task", () => {
  it("names the unprovable task and keeps resolving the rest instead of failing the whole inspection", async () => {
    // 2026-10-09: the active PRT deployment's redpanda-init had a new command and
    // no proven run, so the whole inspection threw and no recovery could be planned.
    const f = fixture();
    f.current.meta = { ...f.current.meta!, composeServices: [{ ...f.task, commandArgv: ["configure", "--topics"] }, f.database] };
    const appRow: ArtifactRow = { ...f.rows[0]!, serviceId: "app", serviceName: "app", containerId: "app-container", status: "success" };
    await expect(resolveReleaseServiceArtifacts(f.current, f.services, [...f.rows, appRow], ["init", "app"], f.reader)).rejects.toThrow();
    const observed = await resolveObservedServiceArtifacts(f.current, f.services, [...f.rows, appRow], ["init", "app"], f.reader);
    expect(observed.unproven).toEqual(["init"]);
    expect(observed.rows.find(row => row.serviceId === "init")!.containerId).toBeNull();
    expect(observed.rows.find(row => row.serviceId === "app")!.containerId).toBe("app-container");
  });
  it("resolves exactly like acceptance when every task is proven", async () => {
    const f = fixture();
    const observed = await resolveObservedServiceArtifacts(f.current, f.services, f.rows, ["init"], f.reader);
    expect(observed.unproven).toEqual([]);
    expect(observed.rows[0]).toMatchObject({ containerId: "original-container", sourceDeploymentId: "origin" });
  });
});
