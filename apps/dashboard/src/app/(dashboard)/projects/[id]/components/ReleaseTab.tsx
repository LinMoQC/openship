"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReleaseCheck, ReleasePlan, ReleaseRun, ReleaseStage, ReleaseState } from "@repo/contracts";
import { Icon, type IconName } from "@repo/ui/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/Tabs";
import { ApiError, getApiErrorMessage, isAbortError, isNetworkError } from "@/lib/api/client";
import { releasesApi } from "@/lib/api/releases";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ReleaseVersionTable } from "@/components/releases/ReleaseVersionTable";
import { ReleaseEnvironmentChip, ReleaseStageBadge, ReleaseStatusBadge, isActiveReleaseStage, releaseEnvironmentLabel } from "@/components/releases/release-ui";
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
  const active = !!run && isActiveReleaseStage(run.stage);
  const environment = state?.binding.environment;
  const label = [projectData.name, releaseEnvironmentLabel(environment, t)].filter(Boolean).join(" ");
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
        if (!isActiveReleaseStage(result.data.stage)) { const fresh = await apiClient.state(id, true); if (!disposed && ticket === generation.current) setState(fresh.data); }
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
  const cooling = !!state?.retryAt && Date.parse(state.retryAt) > clock && state.checks.some(check => check.key === "inspection.github.rate_limit");
  const target = plan?.target ?? state?.target;
  const unchanged = !!target && !target.services.length;
  const production = environment === "production";
  const canSubmit = !!state && !state.stale && state.current.verified && !!plan && !blocked && !expired && !alreadySubmitted && !active && (!unchanged || plan.target.action === "verify") && (!production || confirm === "production");
  const rollbackReady = action !== "rollback" || /^[a-f0-9]{40}$/.test(rollbackCommit.trim());
  const planLocked = loading || cooling || submitting || active || pending || !rollbackReady;
  const submitLabel = plan?.target.action === "verify" ? c.verify : unchanged ? c.noChange : production ? c.production : c.submit;
  const operations = (environment === "preview" ? ["release", "rollback", "verify"] as const : ["release", "rollback"] as const).map(mode => ({ key: mode, label: c[mode] }));
  const notice = pending ? c.pendingSubmission : error ?? state?.error ?? null;

  return <section className="min-w-0 space-y-5">
    <div className="rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-base font-semibold text-foreground" title={projectData.name}>{projectData.name || c.title}</h2>
            <ReleaseEnvironmentChip environment={environment} />
            {state && <ReleaseStatusBadge kind={state.kind} />}
          </div>
          {state && <p className="mt-1 text-xs text-muted-foreground">
            <time dateTime={state.checkedAt} title={new Date(state.checkedAt).toLocaleString()}>{interpolate(c.checkedAgo, { time: timeAgo(state.checkedAt, t) })}</time>
            {state.stale && <span className="ms-2 text-warning">{c.stale}</span>}
          </p>}
        </div>
        <Button variant="outline" size="sm" disabled={loading || cooling} onClick={() => void refresh()} aria-label={`${c.refresh} ${label}`}>
          <Icon name={loading ? "spinner" : "refresh"} className={cn(loading && "animate-spin")} />{c.refresh}
        </Button>
      </div>
      {notice && <Notice className="mt-4" action={<Button variant="ghost" size="sm" disabled={cooling || loading} onClick={() => void refresh()}>{c.retry}</Button>}>
        {notice}
        {cooling && state?.retryAt && <span className="mt-0.5 block text-xs">{c.retryAt} <time dateTime={state.retryAt}>{new Date(state.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span>}
      </Notice>}
      {(githubRequired || state?.checks.some(check => check.key === "inspection.github.connection")) && <div className="mt-4"><ReleaseGitHubConnect /></div>}
      {state ? <ReleaseVersionTable className="mt-5" current={state.current} target={target ?? null} />
        : loading && <div className="mt-5 space-y-2" aria-hidden="true">{[0, 1].map(i => <div key={i} className="h-5 animate-pulse rounded bg-muted" />)}</div>}
    </div>

    {state && <div className="rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{c.planTitle}</h3>
        <Tabs variant="pills" size="sm" ariaLabel={c.operation} tabs={operations} value={action}
          onChange={mode => { if (active || submitting || pending) return; setAction(mode); setPlan(null); setConfirm(""); }} />
      </div>
      {action === "rollback" && <label className="mt-4 block">
        <span className="text-sm text-foreground">{c.rollbackCommit}</span>
        <Input value={rollbackCommit} onChange={e => { setRollbackCommit(e.target.value); setPlan(null); }} placeholder="0123456789abcdef…" maxLength={40} spellCheck={false} autoComplete="off" variant="filled" className="mt-2 font-mono text-xs" />
      </label>}

      <ReleaseChecks className="mt-4" checks={checks} />

      {plan && <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 border-t border-border/40 pt-4 text-sm">
        <dt className="text-muted-foreground">{c.source}</dt>
        <dd className="min-w-0"><code className="font-mono text-xs text-foreground" title={plan.target.workflowSha}>{plan.target.workflowSha.slice(0, 12)}</code></dd>
        <dt className="text-muted-foreground">{c.scope}</dt>
        <dd className="flex min-w-0 flex-wrap gap-1.5">{plan.target.services.length
          ? plan.target.services.map(service => <span key={service} className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground">{service}</span>)
          : <span className="text-muted-foreground">{c.noChange}</span>}</dd>
        <dt className="text-muted-foreground">{c.expires}</dt>
        <dd className={cn("min-w-0", expired && "text-warning")}>
          <time dateTime={plan.expiresAt} title={new Date(plan.expiresAt).toLocaleString()}>{new Date(plan.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          {expired && <span className="ms-2">{c.expired}</span>}
        </dd>
        <dt className="text-muted-foreground">{c.planId}</dt>
        <dd className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={plan.summaryHash}>{plan.id}</dd>
      </dl>}

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border/40 pt-4">
        {plan && production && !alreadySubmitted ? <label className="min-w-0 flex-1 basis-60">
          <span className="text-xs text-muted-foreground">{c.confirmation}</span>
          <Input aria-label={c.confirmLabel} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="production" autoComplete="off" spellCheck={false} variant="filled" className="mt-1.5 h-10 max-w-xs font-mono" />
        </label> : <span />}
        <div className="flex flex-wrap items-center gap-2">
          {plan && <Button variant="ghost" size="sm" onClick={() => void makePlan()} disabled={planLocked}>{c.createPlan}</Button>}
          {plan
            ? <Button disabled={!canSubmit || submitting} onClick={() => void submit()} aria-label={`${submitLabel} ${label}`}>
                {submitting && <Icon name="spinner" className="animate-spin" />}{submitLabel}
              </Button>
            : <Button onClick={() => void makePlan()} disabled={planLocked} aria-label={`${c.generatePlan} ${label}`}>
                {loading && <Icon name="spinner" className="animate-spin" />}{c.generatePlan}
              </Button>}
        </div>
      </div>
    </div>}

    {run && <ReleaseRunCard run={run} />}
  </section>;
}

function Notice({ children, action, className }: { children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return <div role="status" className={cn("flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm", className)}>
    <Icon name="alert-circle" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1 break-words text-muted-foreground">{children}</div>
    {action}
  </div>;
}

function checkIcon(check: ReleaseCheck): { name: IconName; tone: string } {
  if (check.status === "pass") return { name: "check-circle", tone: "text-success" };
  if (check.status === "fail") return check.blocking ? { name: "x-circle", tone: "text-danger" } : { name: "alert-circle", tone: "text-warning" };
  return { name: "help-circle", tone: check.blocking ? "text-warning" : "text-muted-foreground" };
}

/** Problems stay open; passing checks fold into one line so the list reads as a verdict. */
function ReleaseChecks({ checks, className }: { checks: ReleaseCheck[]; className?: string }) {
  const { t } = useI18n(), c = t.projects.release;
  const [showPassed, setShowPassed] = useState(false);
  const attention = checks.filter(check => check.status !== "pass");
  const passed = checks.filter(check => check.status === "pass");
  const blocking = attention.some(check => check.blocking);
  if (!checks.length) return null;
  return <div className={className}>
    <div className="flex flex-wrap items-center gap-2">
      <h4 className="text-sm text-foreground">{c.checks}</h4>
      <span className={cn("text-xs", attention.length ? (blocking ? "text-danger" : "text-warning") : "text-success")}>
        {attention.length ? interpolate(c.checksAttention, { count: String(attention.length) }) : c.checksAllPassed}
      </span>
    </div>
    {attention.length > 0 && <ul className="mt-2 divide-y divide-border/40">{attention.map(check => <CheckRow key={check.key} check={check} />)}</ul>}
    {passed.length > 0 && <>
      <button type="button" onClick={() => setShowPassed(value => !value)} aria-expanded={showPassed}
        className="mt-2 inline-flex items-center gap-1 rounded-lg py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon name={showPassed ? "chevron-up" : "chevron-down"} className="size-3.5" />
        {interpolate(showPassed ? c.hidePassed : c.showPassed, { count: String(passed.length) })}
      </button>
      {showPassed && <ul className="divide-y divide-border/40">{passed.map(check => <CheckRow key={check.key} check={check} />)}</ul>}
    </>}
  </div>;
}

function CheckRow({ check }: { check: ReleaseCheck }) {
  const c = useI18n().t.projects.release;
  const icon = checkIcon(check);
  return <li className="flex items-start gap-3 py-2.5">
    <Icon name={icon.name} aria-label={c[check.status]} className={cn("mt-0.5 size-4 shrink-0", icon.tone)} />
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
        {check.label}
        {!check.blocking && <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{c.advisory}</span>}
      </p>
      {check.detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{check.detail}</p>}
    </div>
  </li>;
}

const PROGRESS: ReleaseStage[] = ["queued", "syncing", "pulling", "deploying", "health", "verifying", "accepted"];

function ReleaseRunCard({ run }: { run: ReleaseRun }) {
  const { t } = useI18n(), c = t.projects.release;
  const reached = run.stage === "accepted" ? PROGRESS.length : PROGRESS.indexOf(run.stage);
  const tracking = run.stage === "accepted" || isActiveReleaseStage(run.stage) && run.stage !== "recovering";
  return <div className="rounded-2xl bg-card p-5" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-semibold text-foreground">{c.progress}</h3>
      <ReleaseStageBadge stage={run.stage} />
    </div>
    {tracking && <ol className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs">
      {PROGRESS.map((stage, index) => {
        const done = index < reached, current = index === reached;
        return <li key={stage} className="flex items-center gap-1.5">
          {index > 0 && <span aria-hidden="true" className={cn("h-px w-3", done || current ? "bg-foreground/30" : "bg-border")} />}
          <span className={cn("inline-flex items-center gap-1", done ? "text-foreground" : current ? "font-medium text-info" : "text-muted-foreground")}>
            {done ? <Icon name="check" className="size-3.5 text-success" /> : current ? <Icon name="spinner" className="size-3.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-muted-foreground/40" />}
            {c.stages[stage]}
          </span>
        </li>;
      })}
    </ol>}
    {run.error && <Notice className="mt-4">{run.error}</Notice>}
    <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 border-t border-border/40 pt-4 text-sm">
      {run.workflowRunId && <>
        <dt className="text-muted-foreground">{c.workflow}</dt>
        <dd className="min-w-0">{run.workflowUrl
          ? <a className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline" href={run.workflowUrl} target="_blank" rel="noopener noreferrer">#{run.workflowRunId}<Icon name="external-link" className="size-3.5 text-muted-foreground" /></a>
          : <span>#{run.workflowRunId}</span>}</dd>
      </>}
      {run.deploymentId && <>
        <dt className="text-muted-foreground">{c.deployment}</dt>
        <dd className="min-w-0 truncate font-mono text-xs text-foreground">{run.deploymentId}</dd>
      </>}
      <dt className="text-muted-foreground">{c.runId}</dt>
      <dd className="min-w-0 truncate font-mono text-xs text-muted-foreground">{run.id}</dd>
    </dl>
    {run.receipt && <details className="group mt-4">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <Icon name="chevron-right" className="size-3.5 transition-transform group-open:rotate-90" />{c.receipt}
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-muted/60 p-3 text-xs">{JSON.stringify(run.receipt, null, 2)}</pre>
    </details>}
  </div>;
}
