import { AppError } from "@repo/contracts";
import type { ReleaseCheck } from "@repo/contracts";

/** Requirements belong to the explicit stack contract. Public checks contain
 * names and configuration states, never environment values. */
export interface ReleaseEnvironmentGroup {
  key: string;
  label: string;
  enabled: boolean;
  required: string[];
  optional?: string[];
}
export function checkReleaseEnvironment(groups: ReleaseEnvironmentGroup[], environment: Record<string, string>): ReleaseCheck[] {
  const seen = new Set<string>();
  return groups.map(group => {
    const names = [...group.required, ...(group.optional ?? [])];
    if (!/^[a-z][a-z0-9.-]*$/.test(group.key) || seen.has(group.key) ||
        typeof group.enabled !== "boolean" || !group.label || !group.required.length ||
        new Set(names).size !== names.length || names.some(name => !/^[A-Z][A-Z0-9_]*$/.test(name)))
      throw new AppError("Invalid feature environment contract", 409, "RELEASE_ENVIRONMENT_CONTRACT_INVALID");
    seen.add(group.key);
    if (!group.enabled) return { key: `environment.${group.key}`, label: group.label, status: "pass", blocking: false, detail: "此功能未启用，无必填项" };
    const present = (name: string) => !!environment[name]?.trim();
    const missing = group.required.filter(name => !present(name));
    const optional = (group.optional ?? []).map(name => `${name}：${present(name) ? "已配置" : "可选，未配置"}`);
    return {
      key: `environment.${group.key}`, label: group.label, status: missing.length ? "fail" : "pass", blocking: true,
      detail: [missing.length ? `缺少必填项 ${missing.join("、")}` : "功能必填项已配置", ...optional].join("；"),
    };
  });
}
