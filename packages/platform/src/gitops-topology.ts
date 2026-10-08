import { parsePortBindings, scopeVolumeBinds, isHostPathSource } from "@repo/adapters";
import type { ComposeAdvanced } from "@repo/core";

export interface ReleaseTopology {
  ports: Record<string, Array<{ HostIp?: string; HostPort: string }> | null>;
  networks: string[];
  networkMode: string;
  pidMode: string;
  mounts: Array<{ source: string; target: string; readOnly: boolean; type: string }>;
  implicitImageMounts?: ReleaseTopology["mounts"];
  running?: boolean;
  exitCode?: number;
}
interface ExpectedServiceTopology {
  ports: string[]; volumes: string[]; advanced?: ComposeAdvanced | null;
}
/** A target prerequisite failure must not erase the incumbent's attestation. */
export function missingTargetTopology(required: ReadonlyArray<{ variable: string }>): { status: "fail"; detail: string } {
  return { status: "fail", detail: `目标缺少必需变量 ${[...new Set(required.map(row => row.variable))].sort().join("、")}，拓扑尚未就绪` };
}
const sorted = (values: unknown[]) => values.map(value => JSON.stringify(value)).sort().join("\n");
export function checkReleaseTopology(service: ExpectedServiceTopology, actual: ReleaseTopology, options: {
  slug: string; namespaceVolumes: boolean; containerIds: Record<string, string>;
  /** Target checks only: the target may add mounts, never change or drop one. */
  allowAddedMounts?: boolean;
}): { status: "pass" | "fail" | "unknown"; detail: string } {
  const reasons: string[] = [];
  const expectedPorts = parsePortBindings(service.ports).portBindings;
  const ports = (value: ReleaseTopology["ports"]) => Object.entries(value).flatMap(([port, bindings]) => (bindings ?? []).map(binding => ({ port, ip: binding.HostIp || "0.0.0.0", hostPort: binding.HostPort })));
  if (Object.values(expectedPorts).some(bindings => bindings.some(binding => !binding.HostPort)))
    return { status: "unknown", detail: "动态主机端口无法确认固定拓扑" };
  if (sorted(ports(expectedPorts)) !== sorted(ports(actual.ports))) reasons.push("主机端口或监听地址不一致");
  function namespace(value: string | undefined) {
    if (value?.startsWith("service:")) {
      const id = options.containerIds[value.slice(8)];
      return id ? `container:${id}` : null;
    }
    return value ?? "";
  }
  const networkMode = namespace(service.advanced?.networkMode);
  const pidMode = namespace(service.advanced?.pidMode);
  if (networkMode === null || pidMode === null) return { status: "unknown", detail: "共享命名空间所属容器无法确认" };
  if (pidMode !== actual.pidMode) reasons.push("进程命名空间不一致");
  const expectedNetwork = service.advanced?.externalNetworkName ?? `openship-${options.slug}`;
  if (networkMode) {
    if (actual.networkMode !== networkMode) reasons.push("网络命名空间不一致");
  } else if (sorted(actual.networks) !== sorted([expectedNetwork])) reasons.push("网络名称或归属不一致");
  const volumes = scopeVolumeBinds(options.slug, service.volumes, options.namespaceVolumes, service.advanced?.externalVolumeNames);
  const expectedMounts: ReleaseTopology["mounts"] = [];
  for (const volume of volumes) {
    const [source, target, ...modes] = volume.split(":");
    if (!source || !target) return { status: "unknown", detail: "匿名卷或无效挂载无法确认归属" };
    expectedMounts.push({ source, target, readOnly: modes.includes("ro"), type: isHostPathSource(source) ? "bind" : "volume" });
  }
  // Completed immutable jobs do not serve or retain application data. Their
  // verified image-created mounts are separate from requested Compose mounts.
  // Running services, failed jobs and any explicit volume remain strict.
  const implicit = service.advanced?.runToCompletion === true && actual.running === false && actual.exitCode === 0 && !service.volumes.length
    ? new Set((actual.implicitImageMounts ?? []).map(mount => JSON.stringify(mount))) : new Set<string>();
  const actualMounts = actual.mounts.filter(mount => !implicit.has(JSON.stringify(mount)));
  const mountKey = (m: ReleaseTopology["mounts"][number]) => `${m.type}|${m.source}|${m.target}|${m.readOnly ? "ro" : "rw"}`;
  const expectedKeys = new Set(expectedMounts.map(mountKey)), actualKeys = new Set(actualMounts.map(mountKey));
  const added = expectedMounts.filter(m => !actualKeys.has(mountKey(m)));
  // Every running mount must survive unchanged; an addition may not reuse a
  // mount point, so it can never shadow or replace data the service holds.
  const additive = options.allowAddedMounts === true && actualMounts.every(m => expectedKeys.has(mountKey(m)))
    && added.every(m => !actualMounts.some(a => a.target === m.target));
  if (sorted(expectedMounts) !== sorted(actualMounts) && !additive) reasons.push("卷、挂载路径或读写权限不一致");
  if (!reasons.length && additive && added.length) return { status: "pass", detail: `保留现有挂载，目标新增 ${added.map(m => m.target).join("、")}` };
  return { status: reasons.length ? "fail" : "pass", detail: reasons.join("、") || "端口、监听地址、网络及卷归属与已部署清单一致" };
}
