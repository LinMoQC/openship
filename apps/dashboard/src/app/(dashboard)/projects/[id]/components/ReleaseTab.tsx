"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReleasePlan, ReleaseRun, ReleaseState } from "@repo/contracts";
import { RELEASE_ACTIVE_STAGES } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { ApiError, getApiErrorMessage, isAbortError, isNetworkError } from "@/lib/api/client";
import { releasesApi } from "@/lib/api/releases";
import { ReleaseGitHubConnect } from "./ReleaseGitHubConnect";
const volatileSubmissionKeys = new Map<string, string>();
function submissionKey(planId: string) {
  const name = `openship-release-key:${planId}`;
  let saved: string | null = null;
  try { saved = sessionStorage.getItem(name); } catch { /* restricted storage */ }
  const existing = saved ?? volatileSubmissionKeys.get(name);
  if (existing) return existing;
  const key = crypto.randomUUID(); volatileSubmissionKeys.set(name, key);
  try { sessionStorage.setItem(name, key); } catch { /* retain this page session key */ }
  return key;
}
export function ReleaseTab() {
  const { projectData } = useProjectSettings();
  return <ReleaseWorkspace projectData={{ id: String(projectData.id ?? ""), name: String(projectData.name ?? "") }} />;
}
/** Shared presentation, also exercised by the isolated development preview. */
export function ReleaseWorkspace({ projectData, apiClient = releasesApi }: { projectData: { id: string; name: string }; apiClient?: typeof releasesApi }) {
  const { t } = useI18n(), c = t.projects.release;
  const id = String(projectData.id ?? "");
  const [state, setState] = useState<ReleaseState | null>(null);
  const [plan, setPlan] = useState<ReleasePlan | null>(null);
  const [run, setRun] = useState<ReleaseRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [githubRequired, setGithubRequired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState(false);
  const [action, setAction] = useState<"release" | "rollback" | "verify">("release");
  const [rollbackCommit, setRollbackCommit] = useState("");
  const [confirm, setConfirm] = useState("");
  const [clock, setClock] = useState(Date.now());
  const generation = useRef(0);
  const reads = useRef(0);
  const active = !!run && (RELEASE_ACTIVE_STAGES as readonly string[]).includes(run.stage);
  const label = state ? `${projectData.name} · ${state.binding.environment === "preview" ? "PRT" : t.projects.sidebar.production}` : String(projectData.name ?? "");
  const refresh = useCallback(async () => {
    const ticket = generation.current, read = ++reads.current; setLoading(true); setError(null);
    try {
      const [result, latest] = await Promise.all([apiClient.state(id, true), apiClient.latest(id)]);
      if (ticket !== generation.current || read !== reads.current) return;
      setState(result.data); setRun(latest.data);
      if (latest.data) {
        const saved = await apiClient.getPlan(latest.data.planId);
        if (ticket === generation.current && read === reads.current) setPlan(current => current && Date.parse(current.createdAt) > Date.parse(saved.data.createdAt) ? current : saved.data);
      }
    } catch (e) { if (ticket === generation.current && read === reads.current) { setError(e instanceof ApiError && e.status === 404 ? c.notBound : getApiErrorMessage(e, c.stateError)); setState(current => current ? { ...current, stale: true } : current); } }
    finally { if (ticket === generation.current && read === reads.current) setLoading(false); }
  }, [id, c.notBound, c.stateError, apiClient]);
  useEffect(() => {
    generation.current += 1; setState(null); setPlan(null); setRun(null); setPending(false); setConfirm(""); setGithubRequired(false); void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!run || !active) return;
    const ticket = generation.current; let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await apiClient.run(run.id);
        if (disposed || ticket !== generation.current) return;
        setRun(result.data); setError(null);
        if (!(RELEASE_ACTIVE_STAGES as readonly string[]).includes(result.data.stage)) { const fresh = await apiClient.state(id, true); if (!disposed && ticket === generation.current) setState(fresh.data); }
      } catch (e) { if (!disposed && ticket === generation.current) setError(getApiErrorMessage(e, c.runError)); }
      if (!disposed) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500); return () => { disposed = true; clearTimeout(timer); };
  }, [run?.id, active, id, c.runError, apiClient]);
  async function makePlan() {
    const ticket = generation.current; setLoading(true); setError(null);
    try { const result = await apiClient.plan(id, { action, ...(action === "rollback" ? { manifestCommit: rollbackCommit.trim() } : {}) }); if (ticket === generation.current) { setPlan(result.data); setPending(false); setConfirm(""); } }
    catch (e) { if (ticket === generation.current) setError(getApiErrorMessage(e, c.planError)); }
    finally { if (ticket === generation.current) setLoading(false); }
  }
  async function submit() {
    if (!plan || !canSubmit || submitting) return;
    const ticket = generation.current; setSubmitting(true); setError(null);
    setGithubRequired(false);
    try {
      const result = await apiClient.start(plan.id, submissionKey(plan.id), state?.binding.environment === "production" && confirm === "production" ? confirm : undefined);
      if (ticket === generation.current) { setRun(result.data); setPending(false); }
    } catch (e) {
      if (ticket === generation.current) {
        const code = e instanceof ApiError && e.body && typeof e.body === "object" && "code" in e.body ? e.body.code : null;
        setGithubRequired(code === "GITHUB_USER_CONNECTION_REQUIRED" || code === "GITHUB_USER_PERMISSION_REQUIRED");
        setPending(isAbortError(e) || isNetworkError(e)); setError(getApiErrorMessage(e));
        // The backend owns idempotency. Look up the persisted run before offering a retry.
        try { const latest = await apiClient.latest(id); if (ticket === generation.current && latest.data?.planId === plan.id) { setRun(latest.data); setPending(false); } } catch { /* retain the last confirmed state */ }
      }
    } finally { if (ticket === generation.current) setSubmitting(false); }
  }
  const checks = plan?.checks ?? state?.checks ?? [];
  const blocked = checks.some(check => check.blocking && check.status !== "pass");
  const expired = !!plan && Date.parse(plan.expiresAt) <= clock && !plan.consumedAt;
  const alreadySubmitted = !!plan && (!!plan.consumedAt || run?.planId === plan.id);
  const target = plan?.target ?? state?.target;
  const unchanged = !!target && !target.services.length;
  const canSubmit = !!state && !state.stale && state.current.verified && !!plan && !blocked && !expired && !alreadySubmitted && !active && (!unchanged || plan.target.action === "verify") && (state?.binding.environment !== "production" || confirm === "production");
  return <section className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="break-words text-lg font-semibold">{label || c.title}</h2><p className="mt-1 text-sm text-muted-foreground">{state ? c.status[state.kind] : c.title}</p></div>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()} aria-label={`${c.refresh} · ${label}`}><Icon name="refresh" />{c.refresh}</Button>
    </div>
    {(error || state?.error || pending) && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-sm"><span className="min-w-0 break-words text-muted-foreground">{pending ? c.pendingSubmission : error ?? state?.error}</span><Button variant="ghost" size="sm" onClick={() => void refresh()}>{c.retry}</Button></div>}
    {(githubRequired || state?.kind === "unknown" || (!state && !!error)) && <ReleaseGitHubConnect />}
    {state && <>
      <fieldset className="flex flex-wrap items-center gap-2"><legend className="mb-2 text-xs text-muted-foreground">{c.operation}</legend>{(["release", "rollback", ...(state.binding.environment === "preview" ? ["verify"] : [])] as const).map(mode => <Button key={mode} variant={action === mode ? "secondary" : "outline"} size="sm" aria-pressed={action === mode} disabled={active || submitting || pending} onClick={() => { setAction(mode as typeof action); setPlan(null); setConfirm(""); }}>{c[mode as keyof typeof c] as string}</Button>)}</fieldset>
      {action === "rollback" && <label className="block text-sm">{c.rollbackCommit}<input value={rollbackCommit} onChange={e => { setRollbackCommit(e.target.value); setPlan(null); }} placeholder="0123456789abcdef…" maxLength={40} spellCheck={false} autoComplete="off" className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs" /></label>}
      <p className="text-xs text-muted-foreground">{c.checkTime}: <time dateTime={state.checkedAt}>{new Date(state.checkedAt).toLocaleString()}</time>{state.stale && ` · ${c.stale}`}</p>
      <div className="grid gap-3 sm:grid-cols-2">{[[c.currentVersion, state.current.images, state.current.ossGitSha], [c.targetVersion, target?.images ?? {}, target?.ossGitSha]] .map(([title, images, oss]) => <div key={String(title)} className="min-w-0 rounded-2xl border border-border/60 bg-card p-4"><h3 className="mb-3 text-sm font-medium">{String(title)}</h3><div className="space-y-2">{Object.entries(images as ReleaseState['current']['images']).map(([name, image]) => <div key={name} className="min-w-0"><p className="flex flex-wrap justify-between gap-2 text-xs"><span>{name}</span><code title={image.gitSha ?? undefined}>{image.gitSha?.slice(0, 12) ?? "—"}</code></p><p title={image.digest} className="truncate font-mono text-[11px] text-muted-foreground">{image.digest}</p></div>)}{oss && <p className="flex justify-between text-xs"><span>OSS</span><code title={String(oss)}>{String(oss).slice(0, 12)}</code></p>}</div></div>)}</div>
      <div className="rounded-2xl border border-border/60 bg-card p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">{c.checks}</h3><Button size="sm" variant="outline" onClick={() => void makePlan()} disabled={loading || submitting || active || pending || (action === "rollback" && !/^[a-f0-9]{40}$/.test(rollbackCommit.trim()))} aria-label={`${c.plan} · ${label}`}>{plan ? c.createPlan : c.plan}</Button></div>
        <ul className="divide-y divide-border/40">{checks.map(check => <li key={check.key} className="flex items-start gap-3 py-3"><span aria-label={c[check.status]} className={`mt-0.5 shrink-0 text-xs ${check.status === 'pass' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>{c[check.status]}</span><div className="min-w-0"><p className="text-sm">{check.label}<span className="ml-2 text-[11px] text-muted-foreground">{check.blocking ? c.blocking : c.advisory}</span></p><p className="mt-1 break-words text-xs text-muted-foreground">{check.detail}</p></div></li>)}</ul>
      </div>
    </>}
    {plan && <div className="space-y-3 rounded-2xl border border-border/60 bg-card p-4"><p className="break-all font-mono text-xs text-muted-foreground">{plan.id} · {plan.summaryHash.slice(0, 12)}</p><p className="text-sm">{c.source}: <code>{plan.target.workflowSha.slice(0, 12)}</code> · {plan.target.action === "rollback" ? c.rollback : plan.target.action === "verify" ? c.verify : c.release}</p><p className="text-sm">{c.scope}: {plan.target.services.join(', ') || c.noChange}</p><p className="text-xs text-muted-foreground">{c.expires}: <time dateTime={plan.expiresAt}>{new Date(plan.expiresAt).toLocaleString()}</time></p>{state?.binding.environment === "production" && <label className="block text-sm">{c.confirmation}<input aria-label={c.confirmLabel} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} className="mt-2 block w-full max-w-xs rounded-lg border border-border bg-background px-3 py-2 font-mono" /></label>}<Button size="sm" disabled={!canSubmit || submitting} onClick={() => void submit()} aria-label={`${state?.binding.environment === 'production' ? c.production : c.submit} · ${label}`}>{plan.target.action === "verify" ? c.verify : unchanged ? c.noChange : state?.binding.environment === 'production' ? c.production : c.submit}</Button></div>}
    {run && <div className="space-y-3 rounded-2xl border border-border/60 bg-card p-4" aria-live="polite"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-medium">{c.run}</h3><span className="text-sm">{c.stages[run.stage]}</span></div><p className="break-all font-mono text-xs text-muted-foreground">{run.id}</p>{run.workflowUrl && <a className="text-sm text-primary underline-offset-4 hover:underline" href={run.workflowUrl} target="_blank" rel="noopener noreferrer">{c.workflow} · {run.workflowRunId}</a>}{run.deploymentId && <p className="break-all font-mono text-xs">{run.deploymentId}</p>}{run.error && <p role="status" className="break-words text-sm text-muted-foreground">{run.error}</p>}{run.receipt && <details><summary className="cursor-pointer text-sm">{c.receipt}</summary><pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-muted/30 p-3 text-xs">{JSON.stringify(run.receipt, null, 2)}</pre></details>}</div>}
  </section>;
}
