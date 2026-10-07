import { Value } from "@sinclair/typebox/value";
import { ReleaseCheckSchema } from "@repo/contracts";
import type { SystemIssue } from "./issues.service";

/** The issue kind is the verdict, so every client labels unknown and blocked states honestly. */
export function releaseUpdateStatus(state: unknown, checks: unknown): Pick<SystemIssue, "kind" | "message"> {
  const reason = Array.isArray(checks) ? checks.find(check => Value.Check(ReleaseCheckSchema, check) && check.blocking && check.status !== "pass")?.detail : null;
  switch (state) {
    case "unknown": return { kind: "release_unknown", message: reason || "版本信息尚未确认，请查看发布计划中的检测条件" };
    case "blocked": return { kind: "release_blocked", message: reason || "发布条件未满足，请查看发布计划" };
    case "drift": return { kind: "release_drift", message: "运行镜像与发布清单不一致，请核对当前部署" };
    case "configuration": return { kind: "release_configuration", message: "发布配置存在变化，请核对配置差异" };
    case "available": return { kind: "update_available", message: "" };
    default: return { kind: "release_unknown", message: "版本信息尚未确认，请查看发布计划中的检测条件" };
  }
}
