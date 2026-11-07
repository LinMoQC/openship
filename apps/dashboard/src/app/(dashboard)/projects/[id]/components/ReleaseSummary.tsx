"use client";
import { useEffect, useState } from "react";
import type { ReleaseState } from "@repo/contracts";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { releasesApi } from "@/lib/api/releases";
import { getApiErrorMessage } from "@/lib/api/client";
import { timeAgo } from "@/lib/time";
import { ReleaseVersionTable } from "@/components/releases/ReleaseVersionTable";
import { ReleaseEnvironmentChip, ReleaseStatusBadge, releaseEnvironmentLabel } from "@/components/releases/release-ui";

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
  const label = [name, releaseEnvironmentLabel(resolvedEnvironment, t)].filter(Boolean).join(" ");
  return <section className="min-w-0 rounded-2xl bg-card p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Icon name="git-branch" className="size-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">{c.title}</h2>
        <ReleaseEnvironmentChip environment={resolvedEnvironment} />
        {state && <ReleaseStatusBadge kind={state.kind} />}
      </div>
      <Link href={`/projects/${projectId}/release`} aria-label={`${c.plan} ${label}`}
        className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
        {c.plan}<Icon name="arrow-right" className="size-3.5 rtl:rotate-180" />
      </Link>
    </div>
    {error && <p role="status" className="mt-3 break-words text-sm text-muted-foreground">{error}</p>}
    {state && <>
      <ReleaseVersionTable className="mt-4" current={state.current} target={state.target} />
      <p className="mt-3 text-xs text-muted-foreground">
        <time dateTime={state.checkedAt} title={new Date(state.checkedAt).toLocaleString()}>{interpolate(c.checkedAgo, { time: timeAgo(state.checkedAt, t) })}</time>
        {state.stale && <span className="ms-2 text-warning">{c.stale}</span>}
      </p>
    </>}
  </section>;
}
