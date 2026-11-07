"use client";
import type { ReleaseStateKind } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import type { Project } from "@/constants/mock";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";
import { applicationImages, revisionTitle, sameImage, shortRevision } from "@/components/releases/release-ui";

const KIND_TEXT: Record<ReleaseStateKind, string> = {
  current: "text-success",
  available: "text-info",
  configuration: "text-info",
  drift: "text-warning",
  unknown: "text-muted-foreground",
  blocked: "text-danger",
};

/**
 * One line of release state for GitOps project rows and tiles: the verdict, the
 * running revision and, when it differs, the target. Full commits and digests stay
 * on hover; the release page carries the per-service detail.
 */
export function ProjectReleaseLine({ project, className }: { project: Project; className?: string }) {
  const { t } = useI18n(), c = t.projects.release;
  if (project.managementMode !== "gitops") return null;
  const state = project.releaseOverview;
  const kind = state?.kind ?? "unknown";
  const [service, running] = applicationImages(state?.current.images)[0] ?? [];
  const next = service && state?.target ? state.target.images[service] : undefined;
  const changed = !!running && !!next && !sameImage(running, next);
  const changedCount = state?.target
    ? Object.entries(state.target.images).filter(([name, image]) => !sameImage(state.current.images[name], image)).length
    : 0;
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground", className)}>
      <span role="status" className={cn("shrink-0", KIND_TEXT[kind])}>{c.status[kind]}</span>
      {state?.stale && <span className="shrink-0 text-warning" title={c.stale}><Icon name="clock" className="size-3" aria-label={c.stale} /></span>}
      {running && <code className="min-w-0 truncate font-mono" title={revisionTitle(running)}>{shortRevision(running, next)}</code>}
      {changed && next && <>
        <Icon name="arrow-right" className="size-3 shrink-0 rtl:rotate-180" aria-hidden="true" />
        <code className="min-w-0 truncate font-mono font-medium text-foreground" title={revisionTitle(next)}>{shortRevision(next, running)}</code>
      </>}
      {changedCount - (changed ? 1 : 0) > 0 && <span className="shrink-0">+{changedCount - (changed ? 1 : 0)}</span>}
    </p>
  );
}
