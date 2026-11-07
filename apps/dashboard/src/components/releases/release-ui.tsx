"use client";

import type { ReleaseImage, ReleaseStage, ReleaseStateKind } from "@repo/contracts";
import { RELEASE_ACTIVE_STAGES } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Shared GitOps release marks. Project rows, the overview summary, issue rows and
 * the release workspace all name the environment and state the same way, so the
 * separator-free layout cannot drift between surfaces.
 */

export type ReleaseEnvironment = "preview" | "production";

export function releaseEnvironmentLabel(environment: string | null | undefined, t: Dictionary): string | null {
  return environment === "preview" || environment === "production" ? t.projects.release.environments[environment] : null;
}

/** Neutral chip after a project name: the environment is identity, not status. */
export function ReleaseEnvironmentChip({ environment, className }: { environment: string | null | undefined; className?: string }) {
  const { t } = useI18n();
  const label = releaseEnvironmentLabel(environment, t);
  if (!label) return null;
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground", className)}>
      {label}
    </span>
  );
}

const KIND_TONE: Record<ReleaseStateKind, string> = {
  current: "bg-success-bg text-success",
  available: "bg-info-bg text-info",
  configuration: "bg-info-bg text-info",
  drift: "bg-warning-bg text-warning",
  unknown: "bg-muted text-muted-foreground",
  blocked: "bg-danger-bg text-danger",
};

export function ReleaseStatusBadge({ kind, className }: { kind: ReleaseStateKind | null | undefined; className?: string }) {
  const { t } = useI18n();
  const resolved = kind ?? "unknown";
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", KIND_TONE[resolved], className)}>
      {t.projects.release.status[resolved]}
    </span>
  );
}

const STAGE_TONE: Record<"active" | "accepted" | "failed" | "restored", string> = {
  active: "bg-info-bg text-info",
  accepted: "bg-success-bg text-success",
  failed: "bg-danger-bg text-danger",
  restored: "bg-warning-bg text-warning",
};

export function isActiveReleaseStage(stage: ReleaseStage): boolean {
  return (RELEASE_ACTIVE_STAGES as readonly string[]).includes(stage);
}

export function ReleaseStageBadge({ stage }: { stage: ReleaseStage }) {
  const { t } = useI18n();
  const tone = isActiveReleaseStage(stage) ? "active" : stage === "accepted" ? "accepted" : stage === "restored" ? "restored" : "failed";
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", STAGE_TONE[tone])}>
      {t.projects.release.stages[stage]}
    </span>
  );
}

/** Image identity is the digest; the commit is what people recognise. */
export function sameImage(a: ReleaseImage | undefined, b: ReleaseImage | undefined): boolean {
  return !!a && !!b && a.digest === b.digest;
}

export function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, "").slice(0, 12);
}

/** Short revision for display. Falls back to the digest when the commit is
 *  unknown or when two different images were built from the same commit. */
export function shortRevision(image: ReleaseImage, other?: ReleaseImage): string {
  const commitIsAmbiguous = !!other && !!image.gitSha && image.gitSha === other.gitSha && image.digest !== other.digest;
  return image.gitSha && !commitIsAmbiguous ? image.gitSha.slice(0, 12) : shortDigest(image.digest);
}

export function revisionTitle(image: ReleaseImage): string {
  return [image.gitSha, image.digest].filter(Boolean).join("\n");
}

/** Application images carry a commit; infrastructure images usually do not. */
export function applicationImages(images: Record<string, ReleaseImage> | undefined): [string, ReleaseImage][] {
  const all = Object.entries(images ?? {});
  const application = all.filter(([, image]) => image.gitSha);
  return application.length ? application : all;
}
