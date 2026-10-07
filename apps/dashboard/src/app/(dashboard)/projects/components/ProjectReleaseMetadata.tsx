"use client";
import type { Project } from "@/constants/mock";
import type { Dictionary } from "@/i18n";
import { useI18n } from "@/components/i18n-provider";

function releaseEnvironment(project: Project, t: Dictionary) {
  return project.releaseEnvironment === "production" ? t.projects.sidebar.production : project.releaseEnvironment === "preview" ? "PRT" : t.projects.release.unknown;
}
export function projectReleaseLabel(project: Project, t: Dictionary) {
  return project.managementMode === "gitops" ? `${project.name} · ${releaseEnvironment(project, t)}` : project.name;
}
export function ProjectReleaseName({ project }: { project: Project }) {
  const { t } = useI18n();
  return <p className="flex min-w-0 items-center gap-1 text-sm font-medium text-foreground" title={projectReleaseLabel(project, t)}>
    <span className="truncate">{project.name}</span>
    {project.managementMode === "gitops" && <span className="shrink-0">· {releaseEnvironment(project, t)}</span>}
  </p>;
}

export function ProjectReleaseMetadata({ project }: { project: Project }) {
  const { t } = useI18n(), c = t.projects.release;
  if (project.managementMode !== "gitops") return null;
  const state = project.releaseOverview;
  return <div className="mt-2 min-w-0 space-y-1 text-xs text-muted-foreground">
    <p role="status">{c.status[state?.kind ?? "unknown"]}{state?.stale && ` · ${c.stale}`}</p>
    {(["current", "target"] as const).map(side => {
      const observation = state?.[side];
      const allImages = Object.entries(observation?.images ?? {});
      const applicationImages = allImages.filter(([, image]) => image.gitSha);
      const images = applicationImages.length ? applicationImages : allImages;
      return <div key={side} className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
        <span>{side === "current" ? c.currentVersion : c.targetVersion}</span>
        {!images.length && <span>{c.unknown}</span>}
        {images.slice(0, 2).map(([service, image]) => <code key={service} className="break-all" title={`${service} · ${image.gitSha ?? ""} · ${image.digest}`}>{image.gitSha?.slice(0, 12) ?? image.digest.slice(0, 19)} · {image.digest.slice(7, 19)}</code>)}
        {images.length > 2 && <span>+{images.length - 2}</span>}
        {observation?.ossGitSha && <code title={observation.ossGitSha}>OSS · {observation.ossGitSha.slice(0, 12)}</code>}
      </div>;
    })}
    <p>{c.checkTime}: {state?.checkedAt ? <time dateTime={state.checkedAt}>{new Date(state.checkedAt).toLocaleString()}</time> : c.unknown}</p>
  </div>;
}
