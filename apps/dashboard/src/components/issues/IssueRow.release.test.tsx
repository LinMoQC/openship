import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { loadDictionary } from "@/i18n";
import type { SystemIssue } from "@/lib/api/issues";
import { IssueRow } from "./IssueRow";

describe("GitOps home issue verdict", () => {
  it.each([
    ["release_unknown", "待确认版本"], ["release_blocked", "发布被阻断"],
    ["release_drift", "运行版本不一致"], ["release_configuration", "配置存在变化"],
  ] as const)("renders %s with its own label and an environment-specific plan link", async (kind, label) => {
    const issue: SystemIssue = { id: "update:p", kind, severity: "action_required", scope: "project", source: "update", title: "Commercial Web · PRT", message: "尚未连接有效的 GitHub 身份，请连接账号后重新检测", target: { scope: "project", id: "p", name: "Commercial Web · PRT", href: "/projects/p/release" }, resolveWith: [], details: { gitops: true, applicationName: "Commercial Web", environment: "preview" } };
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh" initialDictionary={await loadDictionary("zh")}><IssueRow issue={issue} busy={false} onResolve={() => {}} onInfraFix={() => {}} /></I18nProvider>);
    expect(html).toContain(label); expect(html).not.toContain("有可用更新");
    expect(html).toContain(issue.message); expect(html).toContain('href="/projects/p/release"');
    expect(html).toContain('aria-label="查看发布计划 · Commercial Web · PRT"');
    expect(html).toContain('class="shrink-0">· PRT');
    expect(html).not.toContain(">Update<");
  });
});
