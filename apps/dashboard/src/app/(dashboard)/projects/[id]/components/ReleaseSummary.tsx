"use client";
import { useEffect, useState } from "react";
import type { ReleaseState } from "@repo/contracts";
import Link from "next/link";
import { useI18n } from "@/components/i18n-provider";
import { releasesApi } from "@/lib/api/releases";
import { getApiErrorMessage } from "@/lib/api/client";

export function ReleaseSummary({ projectId, name, environment }: { projectId: string; name: string; environment?: string }) {
  const [state, setState] = useState<ReleaseState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n(), c = t.projects.release;
  useEffect(() => {
    let disposed = false;
    setState(null); setError(null);
    void releasesApi.state(projectId).then(result => { if (!disposed) setState(result.data); }).catch(e => { if (!disposed) setError(getApiErrorMessage(e, c.stateError)); });
    return () => { disposed = true; };
  }, [projectId, c.stateError]);
  const resolvedEnvironment = state?.binding.environment ?? environment;
  const label = `${name}${resolvedEnvironment ? ` · ${resolvedEnvironment === "production" ? t.projects.sidebar.production : "PRT"}` : ""}`;
  return <section className="min-w-0 rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="break-words text-sm font-semibold">{label}</h2><Link href={`/projects/${projectId}/release`} aria-label={`${c.plan} · ${label}`} className="text-sm text-primary hover:underline">{c.plan}</Link></div>
    {error && <p role="status" className="mt-3 break-words text-sm text-muted-foreground">{error}</p>}
    {state && <><p className="mt-2 text-xs text-muted-foreground">{c.status[state.kind]}{state.stale && ` · ${c.stale}`}</p><div className="mt-4 grid gap-4 sm:grid-cols-2">{(["current", "target"] as const).map(side => <div key={side} className="min-w-0"><h3 className="mb-2 text-xs text-muted-foreground">{side === "current" ? c.currentVersion : c.targetVersion}</h3>{Object.entries(state[side]?.images ?? {}).map(([service, image]) => <p key={service} className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1 text-xs"><span className="break-all">{service}</span><code title={`${image.gitSha ?? ""} · ${image.digest}`}>{image.gitSha?.slice(0, 12) ?? image.digest.slice(0, 19)}</code></p>)}{state[side]?.ossGitSha && <p className="mt-1 text-xs">OSS · <code>{state[side]!.ossGitSha!.slice(0, 12)}</code></p>}</div>)}</div><p className="mt-4 text-xs text-muted-foreground">{c.checkTime}: <time dateTime={state.checkedAt}>{new Date(state.checkedAt).toLocaleString()}</time></p></>}
  </section>;
}
