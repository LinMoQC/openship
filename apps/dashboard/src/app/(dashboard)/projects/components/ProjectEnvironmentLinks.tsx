"use client";

import Link from "next/link";
import type { ProjectEnvironmentSummary } from "@/constants/mock";
import { useI18n } from "@/components/i18n-provider";
import { projectEnvironmentHref } from "@/context/project-environments";
import { getProjectStatus, PROJECT_STATUS_META, projectStatusLabel } from "@/utils/project-status";

/** A group card exposes each environment independently, including drafts. */
export function ProjectEnvironmentLinks({
  environments,
}: {
  environments?: ProjectEnvironmentSummary[];
}) {
  const { t } = useI18n();
  if (!environments?.length) return null;
  return (
    <div className="relative z-10 grid gap-1.5" role="group" aria-label={t.projects.env.switchAria}>
      {environments.map((environment) => {
        const status = getProjectStatus(environment);
        return (
          <Link
            key={environment.id}
            href={projectEnvironmentHref(environment.id, "overview")}
            className="flex min-h-9 min-w-0 items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/70 px-3 py-2 text-xs transition-colors hover:border-primary/40 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span className="truncate font-medium text-foreground">{environment.name}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${PROJECT_STATUS_META[status].badge}`}
            >
              {projectStatusLabel(status, t)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
