import { AppError, type ReleaseCheck } from "@repo/contracts";

class ReleaseRateLimitError extends AppError {
  constructor(readonly retryAt: string) { super("GitHub 请求已限流，请稍后重新检测", 503, "RELEASE_SOURCE_RATE_LIMITED"); }
}

/** Only defined diagnostics may cross the release API; never expose upstream bodies or credentials. */
export function githubReleaseError(error: unknown): AppError {
  if (error instanceof AppError && error.code === "GITHUB_CONNECTION_REQUIRED")
    return new AppError("尚未连接可读取发布仓库的 GitHub 身份，请连接 GitHub 账号", 403, "GITHUB_USER_CONNECTION_REQUIRED");
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 503;
  const credentialRejected = error && typeof error === "object" && "credentialRejected" in error && error.credentialRejected === true;
  if (status === 401) return new AppError("GitHub 连接已失效，请重新连接账号", 403, "GITHUB_USER_CONNECTION_REQUIRED");
  if (status === 429 || (status === 403 && !credentialRejected)) {
    const deadline = error && typeof error === "object" && "retryAt" in error && typeof error.retryAt === "number" ? error.retryAt : NaN;
    return new ReleaseRateLimitError(new Date(Number.isFinite(deadline) && deadline > Date.now() ? deadline : Date.now() + 60_000).toISOString());
  }
  if (status === 403) return new AppError("GitHub 拒绝访问发布仓库，请检查仓库权限", 403, "GITHUB_USER_PERMISSION_REQUIRED");
  if (status === 404) return new AppError("发布仓库、分支或清单无法读取，请检查路径及私有仓库权限", 404, "RELEASE_SOURCE_NOT_FOUND");
  return new AppError("GitHub 发布数据暂不可达，请稍后重新检测", 503, "RELEASE_SOURCE_UNAVAILABLE");
}

export function releaseInspectionFailure(error: unknown): ReleaseCheck {
  const code = error instanceof AppError ? error.code : null;
  const diagnostics: Record<string, { key: string; detail: string }> = {
    GITHUB_USER_CONNECTION_REQUIRED: { key: "github.connection", detail: "尚未连接有效的 GitHub 身份，请连接账号后重新检测" },
    GITHUB_USER_PERMISSION_REQUIRED: { key: "github.access", detail: "GitHub 拒绝访问发布仓库，请检查仓库权限" },
    RELEASE_SOURCE_RATE_LIMITED: { key: "github.rate_limit", detail: "GitHub 请求已限流，请稍后重新检测" },
    RELEASE_SOURCE_NOT_FOUND: { key: "github.source", detail: "发布仓库、分支或清单无法读取，请检查路径及私有仓库权限" },
    RELEASE_SOURCE_UNAVAILABLE: { key: "github.source", detail: "GitHub 发布数据暂不可达，请稍后重新检测" },
    RELEASE_SOURCE_INVALID: { key: "source.contract", detail: "发布清单、环境绑定或服务范围不符合契约，请核对发布配置" },
    RELEASE_TOPOLOGY_UNKNOWN: { key: "runtime.topology", detail: "无法确认已部署配置及容器拓扑，请核对当前部署" },
    LOCAL_HOST_ACCESS_DENIED: { key: "runtime.ownership", detail: "项目工作区与本机主机归属不一致，请核对主机工作区配置" },
    HOST_OWNER_CONFIG_INVALID: { key: "runtime.ownership", detail: "主机工作区配置无效，需要由同一主机创建者拥有该工作区" },
  };
  const diagnostic = (code && diagnostics[code]) || { key: "runtime", detail: "无法核对发布清单或实际容器，请重新检测" };
  return { key: `inspection.${diagnostic.key}`, label: "版本检测", status: "unknown", blocking: true, detail: diagnostic.detail };
}
