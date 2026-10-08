import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { parseComposeFile } from "../src/engine/lib/compose-parser";
import { missingTargetTopology, checkReleaseTopology } from "../src/gitops-topology";
import incumbent from "./fixtures/core-incumbent-13.json";

describe("incumbent topology with an incomplete expanded target", () => {
  it("retains the established 13-service document while blocking the three absent target volume variables", () => {
    const document = YAML.stringify(incumbent.locked);
    const env = Object.fromEntries([...document.matchAll(/\$\{([A-Z_]+)(?::[^}]*)?\}/g)].map(row => [row[1]!, `synthetic-${row[1]!.toLowerCase()}`]));
    const current = parseComposeFile(document, { env });
    expect(current.services).toHaveLength(13);
    expect(current.missingRequired).toEqual([]);
    const target = parseComposeFile(YAML.stringify({ services: {
      ...incumbent.locked.services,
      redpanda: { image: "redpanda@sha256:" + "a".repeat(64), volumes: ["${REDPANDA_VOLUME_NAME:?required}:/data"] },
      "redpanda-init": { image: "redpanda@sha256:" + "a".repeat(64), volumes: ["${OPS_ERROR_LOGS_VOLUME_NAME:?required}:/logs"] },
      "interview-agent": { image: "interview@sha256:" + "a".repeat(64), volumes: ["${CLIPROXY_LOGS_VOLUME_NAME:?required}:/logs"] },
    } }), { env });
    expect(target.services).toHaveLength(16);
    expect(target.missingRequired.map(row => row.variable).sort()).toEqual(["CLIPROXY_LOGS_VOLUME_NAME", "OPS_ERROR_LOGS_VOLUME_NAME", "REDPANDA_VOLUME_NAME"]);
    const blocked = missingTargetTopology(target.missingRequired);
    expect(blocked.status).toBe("fail");
    expect(blocked.detail).toContain("REDPANDA_VOLUME_NAME");
    // A known current topology remains verifiable; the target verdict cannot
    // turn it into unknown or relax its independent port/volume gate.
    const service = { ports: [], volumes: ["retained_data:/data"], advanced: { externalNetworkName: "retained-net", externalVolumeNames: ["retained_data"] } };
    const actual = { ports: {}, networks: ["retained-net"], networkMode: "retained-net", pidMode: "", mounts: [{ source: "retained_data", target: "/data", readOnly: false, type: "volume" }] };
    expect(checkReleaseTopology(service, actual, { slug: "core-production", namespaceVolumes: false, containerIds: {} }).status).toBe("pass");
    expect(checkReleaseTopology(service, { ...actual, networks: ["foreign-net"] }, { slug: "core-production", namespaceVolumes: false, containerIds: {} }).status).toBe("fail");
  });
  it("lets a target add a mount but never change, drop or shadow a running one", () => {
    const options = { slug: "core-production", namespaceVolumes: false, containerIds: {}, allowAddedMounts: true };
    const actual = { ports: {}, networks: ["net"], networkMode: "net", pidMode: "", mounts: [{ source: "data", target: "/data", readOnly: false, type: "volume" }] };
    const target = (volumes: string[]) => ({ ports: [], volumes, advanced: { externalNetworkName: "net", externalVolumeNames: volumes.map(v => v.split(":")[0]!) } });
    const addition = checkReleaseTopology(target(["data:/data", "logs:/logs"]), actual, options);
    expect(addition).toEqual({ status: "pass", detail: "保留现有挂载，目标新增 /logs" });
    expect(checkReleaseTopology(target(["other:/data", "logs:/logs"]), actual, options).status).toBe("fail");
    expect(checkReleaseTopology(target(["logs:/logs"]), actual, options).status).toBe("fail");
    expect(checkReleaseTopology(target(["data:/data:ro"]), actual, options).status).toBe("fail");
    // The deployed-versus-actual check stays strict.
    expect(checkReleaseTopology(target(["data:/data", "logs:/logs"]), actual, { ...options, allowAddedMounts: false }).status).toBe("fail");
  });
  it("reports only deduplicated variable names, never interpolation messages or values", () => {
    const blocked = missingTargetTopology([{ variable: "B" }, { variable: "A" }, { variable: "B" }]);
    expect(blocked).toEqual({ status: "fail", detail: "目标缺少必需变量 A、B，拓扑尚未就绪" });
  });
});
