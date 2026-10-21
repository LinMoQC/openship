import { describe, expect, it } from "vitest";
import { approvedInfrastructureRelease } from "../src/gitops-infrastructure-release";
import { productionReleaseScope } from "../src/gitops-release-scope";

const gitSha = "1".repeat(40), digest = "sha256:" + "2".repeat(64);
const spec = { name: "cliproxy", image: "eceasy/cli-proxy-api", release: { repository: "router-for-me/CLIProxyAPI", versions: { "v8.0.38": { gitSha, digest } } } };
const event = { service: "cliproxy", image: spec.image, repository: spec.release.repository, tag: "v8.0.38", gitSha, digest, migrationsChanged: false };

describe("reviewed infrastructure releases", () => {
  it("accepts the reviewed vendor tuple and scopes both promotion and rollback to that component", () => {
    expect(approvedInfrastructureRelease([spec], event)).toEqual(spec);
    const before = { services: { api: { digest: "same" } }, infrastructure: { cliproxy: { digest: "old" } } };
    const after = { ...before, infrastructure: { cliproxy: { digest } } };
    expect(productionReleaseScope([{ name: "api" }], before, after)).toEqual(["cliproxy"]);
    expect(productionReleaseScope([{ name: "api" }], after, before)).toEqual(["cliproxy"]);
  });
  it.each([{ tag: "latest" }, { tag: "v8.0.39" }, { repository: "attacker/CLIProxyAPI" }, { image: "attacker/proxy" }, { gitSha: "3".repeat(40) }, { digest: "sha256:" + "4".repeat(64) }, { migrationsChanged: true }])("rejects an unreviewed change: %j", change => {
    expect(() => approvedInfrastructureRelease([spec], { ...event, ...change })).toThrow();
  });
  it("does not grant release rights to other infrastructure or change application event handling", () => {
    expect(() => approvedInfrastructureRelease([{ name: "postgres", image: "postgres" }], { ...event, service: "postgres" })).toThrow();
    expect(approvedInfrastructureRelease([spec], { ...event, service: "api" })).toBeNull();
  });
});
