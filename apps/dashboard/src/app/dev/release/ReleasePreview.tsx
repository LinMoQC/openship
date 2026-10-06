"use client";
import { useMemo, useState } from "react";
import type { ReleasePlan, ReleaseRun, ReleaseState } from "@repo/contracts";
import { ReleaseWorkspace } from "@/app/(dashboard)/projects/[id]/components/ReleaseTab";
import type { releasesApi } from "@/lib/api/releases";
type Variant = "available" | "current" | "blocked" | "unknown" | "production";
const variants: Variant[] = ["available", "current", "blocked", "unknown", "production"];
export function ReleasePreview() {
  const [variant, setVariant] = useState<Variant>("available");
  const client = useMemo<typeof releasesApi>(() => {
    const now = new Date().toISOString(), sha = "a".repeat(40), hash = "b".repeat(64);
    const image = { image: "ghcr.io/example/commercial-web", digest: `sha256:${hash}`, gitSha: sha };
    const production = variant === "production";
    const state: ReleaseState = {
      binding: { id: "fixture-binding", projectId: "fixture-project", organizationId: "fixture-org", revision: 1, environment: production ? "production" : "preview", stack: "commercial-web", repository: "example/config", manifestPath: "stacks/commercial-web/release.yaml", targetBranch: production ? "deploy/prod" : "deploy/prt", workflowRef: "main", workflows: { preview: "receive.yml", production: "promote-production.yml", rollback: "rollback.yml" }, controllerTokenIds: ["fixture-controller"], expectedServices: ["web"], probes: ["https://example.invalid/health"] },
      kind: variant === "production" ? "available" : variant,
      current: { deploymentId: "fixture-incumbent", images: { web: image }, configurationHash: hash, serverEnvironmentHash: hash, ossGitSha: sha, verified: variant !== "unknown" },
      target: { action: "release", workflowSha: sha, manifestCommit: sha, manifestHash: hash, configurationHash: hash, releaseId: "commercial-web:fixture", images: { web: variant === "current" ? image : { ...image, gitSha: "c".repeat(40), digest: `sha256:${"d".repeat(64)}` } }, ossGitSha: "e".repeat(40), services: variant === "current" ? [] : ["web"], eventKey: hash, acceptedReceipt: null, manifest: {} },
      checks: [{ key: "scope", label: "服务集合、端口、网络与卷", status: "pass", blocking: true, detail: "准确服务范围为 web，实际拓扑与已部署配置一致" }, { key: "image", label: "镜像摘要与主机架构", status: "pass", blocking: true, detail: "不可变镜像可拉取且架构匹配" }, { key: "identity", label: "操作人与环境授权", status: variant === "blocked" ? "fail" : variant === "unknown" ? "unknown" : "pass", blocking: true, detail: variant === "blocked" ? "此环境尚未完成 activation 验收，请先检查生产接管条件" : "工作流使用当前用户的 GitHub 身份" }], checkedAt: now, stale: variant === "unknown", error: variant === "unknown" ? "无法连接主机，保留最后成功检测结果" : null,
    };
    let plan: ReleasePlan | null = null, run: ReleaseRun | null = null;
    return {
      state: async () => ({ data: state }), latest: async () => ({ data: run }),
      plan: async (_, input = {}) => {
        plan = { id: "fixture-plan", projectId: "fixture-project", organizationId: "fixture-org", bindingRevision: 1, current: state.current, target: { ...state.target!, action: input.action ?? "release", ...(input.action === "verify" ? { images: state.current.images, ossGitSha: state.current.ossGitSha, services: [] } : {}) }, checks: state.checks, summaryHash: hash, createdAt: now, expiresAt: new Date(Date.now() + 600_000).toISOString(), consumedAt: null };
        return { data: plan };
      },
      getPlan: async () => { if (!plan) throw new Error("Fixture plan missing"); return { data: plan }; },
      start: async (_, key, confirmation) => {
        if (!plan || state.stale || plan.checks.some(c => c.blocking && c.status !== "pass") || (production && confirmation !== "production")) throw new Error("Fixture gate rejected");
        run ??= { id: "fixture-run", projectId: "fixture-project", organizationId: "fixture-org", planId: plan.id, origin: "user", userId: "fixture-user", githubActor: "fixture-user", idempotencyKey: key, stage: "accepted", workflowRunId: "123", workflowUrl: null, deploymentId: "fixture-incumbent", receipt: { status: plan.target.action === "verify" ? "noop" : "accepted", fixture: true }, error: null, createdAt: now, updatedAt: now };
        return { data: run };
      },
      run: async () => { if (!run) throw new Error("Fixture run missing"); return { data: run }; },
    };
  }, [variant]);
  return <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-8"><div className="rounded-xl border border-border bg-muted/30 p-4"><p className="text-sm font-medium">隔离界面预览 · 使用样例数据，不会发起真实部署</p><div className="mt-3 flex flex-wrap gap-2">{variants.map(value => <button key={value} type="button" aria-pressed={value === variant} onClick={() => setVariant(value)} className="rounded-lg border border-border bg-card px-3 py-2 text-xs">{value}</button>)}</div></div><ReleaseWorkspace key={variant} projectData={{ id: "fixture-project", name: "Commercial Web · 长应用名称布局与发布操作验收" }} apiClient={client} /></main>;
}
