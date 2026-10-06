import { describe, expect, it } from "vitest";
import { checkReleaseTopology, type ReleaseTopology } from "../src/gitops-topology";
const service = { ports: ["127.0.0.1:3300:3000"], volumes: ["existing_data:/data", "/srv/config:/config:ro"], advanced: { externalNetworkName: "magic-prt", externalVolumeNames: ["existing_data"] } };
const actual: ReleaseTopology = { ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3300" }] }, networks: ["magic-prt"], networkMode: "magic-prt", pidMode: "", mounts: [{ source: "existing_data", target: "/data", readOnly: false, type: "volume" }, { source: "/srv/config", target: "/config", readOnly: true, type: "bind" }] };
const options = { slug: "web-prt", namespaceVolumes: true, containerIds: { database: "exact-database-id" } };
describe("actual GitOps runtime topology", () => {
  it("preserves explicitly owned external volumes and networks", () => {
    expect(checkReleaseTopology(service, actual, options).status).toBe("pass");
  });
  it.each([
    { ...actual, ports: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3300" }] } },
    { ...actual, networks: ["magic-prod"] },
    { ...actual, mounts: actual.mounts.map(m => ({ ...m, readOnly: false })) },
    { ...actual, mounts: actual.mounts.map(m => ({ ...m, source: m.source === "existing_data" ? "empty_new_data" : m.source })) },
    { ...actual, mounts: [...actual.mounts, { source: "unowned", target: "/extra", readOnly: false, type: "volume" }] },
  ])("blocks an actual topology mismatch even with an identical image", changed => {
    expect(checkReleaseTopology(service, changed, options).status).toBe("fail");
  });
  it("uses the scoped volume name only for a volume owned by this project", () => {
    const configured = { ports: [], volumes: ["data:/data"] };
    expect(checkReleaseTopology(configured, { ...actual, ports: {}, networks: ["openship-web-prt"], mounts: [{ source: "openship-web-prt-data", target: "/data", readOnly: false, type: "volume" }] }, options).status).toBe("pass");
  });
  it("resolves shared namespaces to the exact sibling container", () => {
    const configured = { ports: [], volumes: [], advanced: { networkMode: "service:database", pidMode: "service:database" } };
    expect(checkReleaseTopology(configured, { ...actual, ports: {}, mounts: [], networkMode: "container:exact-database-id", pidMode: "container:exact-database-id" }, options).status).toBe("pass");
    expect(checkReleaseTopology(configured, { ...actual, ports: {}, mounts: [], networkMode: "container:foreign-database", pidMode: "container:exact-database-id" }, options).status).toBe("fail");
  });
  it("reports unknown rather than assuming anonymous volume identity", () => {
    expect(checkReleaseTopology({ ports: [], volumes: ["/data"] }, actual, options).status).toBe("unknown");
  });
});
