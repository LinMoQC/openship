"use client";

import type { ReleaseImage } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";
import { revisionTitle, sameImage, shortRevision } from "./release-ui";

type Side = { images: Record<string, ReleaseImage>; ossGitSha: string | null } | null | undefined;

/**
 * Running and target revisions side by side, one row per service. Unchanged
 * targets collapse to a muted word so the rows that will change stand out;
 * full commits and digests stay available on hover.
 */
export function ReleaseVersionTable({ current, target, className }: { current: Side; target: Side; className?: string }) {
  const { t } = useI18n();
  const c = t.projects.release;
  const services = [...new Set([...Object.keys(current?.images ?? {}), ...Object.keys(target?.images ?? {})])].sort();
  const oss = current?.ossGitSha || target?.ossGitSha;
  if (!services.length && !oss) return <p className={cn("text-sm text-muted-foreground", className)}>{c.unknown}</p>;

  return (
    <table className={cn("w-full table-fixed text-sm", className)}>
      <thead>
        <tr className="text-xs text-muted-foreground">
          <th scope="col" className="pb-2 text-start font-normal">{c.service}</th>
          <th scope="col" className="w-[34%] pb-2 text-start font-normal">{c.currentVersion}</th>
          <th scope="col" className="w-[34%] pb-2 text-start font-normal">{c.targetVersion}</th>
        </tr>
      </thead>
      <tbody>
        {services.map((service) => {
          const running = current?.images[service];
          const next = target ? target.images[service] : undefined;
          return (
            <tr key={service} className="border-t border-border/40">
              <th scope="row" className="truncate py-2.5 pe-3 text-start font-normal text-foreground" title={service}>{service}</th>
              <td className="py-2.5 pe-3">
                {running ? <Revision value={shortRevision(running, next)} title={revisionTitle(running)} /> : <Muted>{c.unknown}</Muted>}
              </td>
              <td className="py-2.5">
                {!next ? <Muted>{target ? c.removed : c.unknown}</Muted>
                  : sameImage(running, next) ? <Muted>{c.unchanged}</Muted>
                  : <Revision value={shortRevision(next, running)} title={revisionTitle(next)} changed />}
              </td>
            </tr>
          );
        })}
        {oss && (
          <tr className="border-t border-border/40">
            <th scope="row" className="py-2.5 pe-3 text-start font-normal text-foreground">{c.ossSource}</th>
            <td className="py-2.5 pe-3">{current?.ossGitSha ? <Revision value={current.ossGitSha.slice(0, 12)} title={current.ossGitSha} /> : <Muted>{c.unknown}</Muted>}</td>
            <td className="py-2.5">
              {!target?.ossGitSha ? <Muted>{c.unknown}</Muted>
                : target.ossGitSha === current?.ossGitSha ? <Muted>{c.unchanged}</Muted>
                : <Revision value={target.ossGitSha.slice(0, 12)} title={target.ossGitSha} changed />}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Revision({ value, title, changed }: { value: string; title: string; changed?: boolean }) {
  return (
    <code title={title} className={cn("block truncate font-mono text-xs", changed ? "font-medium text-foreground" : "text-muted-foreground")}>
      {value}
    </code>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="block truncate text-xs text-muted-foreground">{children}</span>;
}
