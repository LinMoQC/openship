import { describe, expect, it } from "vitest";
import type { ReleaseState } from "@repo/contracts";
import { projectReleaseOverview } from "../src/engine/modules/projects/project-release-overview";
const now = Date.parse("2026-10-07T00:00:00.000Z");
const sha = "b".repeat(40), hash = "c".repeat(64);
function fixture() {
  const images = { web: { image: "ghcr.io/example/web", digest: `sha256:${"a".repeat(64)}`, gitSha: sha } };
  const lastState: ReleaseState = {
    binding: { id: "binding", projectId: "p", organizationId: "org", revision: 1, environment: "preview", stack: "commercial-web", repository: "Example/Config", manifestPath: "stacks/commercial-web/release.yaml", targetBranch: "deploy/prt", workflowRef: "main", workflows: { preview: "receive.yml", production: "promote.yml", rollback: "rollback.yml" }, controllerTokenIds: ["private-controller"], expectedServices: ["web"], probes: ["https://example.com"] },
    kind: "current", current: { deploymentId: "d", images, configurationHash: hash, ossGitSha: sha, verified: true },
    target: { action: "release", workflowSha: sha, manifestCommit: sha, manifestHash: hash, configurationHash: hash, releaseId: "web:release", images, ossGitSha: sha, services: ["web"], eventKey: null, acceptedReceipt: null, manifest: { privateConfiguration: "must-not-be-exposed" } },
    checks: [], checkedAt: new Date(now).toISOString(), stale: false, error: null,
  };
  return { projectId: "p", organizationId: "org", revision: 1, lastState, checkedAt: new Date(now) };
}
describe("cached project release overview", () => {
  it("projects actual versions and OSS without raw manifest or controller identity", () => {
    const state = projectReleaseOverview(fixture(), now);
    expect(state.kind).toBe("current"); expect(state.current.ossGitSha).toBe(sha);
    expect(JSON.stringify(state)).not.toContain("private-controller");
    expect(JSON.stringify(state)).not.toContain("privateConfiguration");
  });
  it("preserves last evidence but marks an expired or invalidated check unknown", () => {
    for (const checkedAt of [new Date(now - 300_000), null, new Date(now + 1)]) {
      const state = projectReleaseOverview({ ...fixture(), checkedAt }, now);
      expect(state.kind).toBe("unknown"); expect(state.stale).toBe(true); expect(state.current.images.web.gitSha).toBe(sha);
    }
  });
  it("rejects malformed, cross-project, cross-organization or old-revision caches", () => {
    for (const patch of [{ projectId: "other" }, { organizationId: "other" }, { revision: 2 }, { lastState: {} }]) {
      const state = projectReleaseOverview({ ...fixture(), ...patch }, now);
      expect(state.kind).toBe("unknown"); expect(state.current.images).toEqual({}); expect(state.checkedAt).toBeNull();
    }
  });
  it("never presents a failed initial inspection as a successful check", () => {
    const row = fixture(); row.lastState.kind = "unknown"; row.lastState.stale = true; row.lastState.current.verified = false;
    expect(projectReleaseOverview(row, now).checkedAt).toBeNull();
  });
});
