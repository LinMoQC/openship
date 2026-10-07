import { Value } from "@sinclair/typebox/value";
import { ReleaseStateSchema, type ReleaseOverview, type ReleaseImage } from "@repo/contracts";

export function projectReleaseOverview(row: { projectId: string; organizationId: string; revision: number; lastState: unknown; checkedAt: Date | null }, now = Date.now()): ReleaseOverview {
  const state = row.lastState;
  if (!Value.Check(ReleaseStateSchema, state) || state.binding.projectId !== row.projectId || state.binding.organizationId !== row.organizationId || state.binding.revision !== row.revision)
    return { kind: "unknown", current: { deploymentId: null, images: {}, configurationHash: null, ossGitSha: null, verified: false }, target: null, checkedAt: null, stale: true };
  const expired = !row.checkedAt || now - row.checkedAt.getTime() >= 300_000 || row.checkedAt.getTime() > now;
  const images = (values: Record<string, ReleaseImage>) => Object.fromEntries(Object.entries(values).map(([service, image]) => [service, { image: image.image, digest: image.digest, gitSha: image.gitSha }]));
  return { kind: expired || state.stale ? "unknown" : state.kind,
    current: { deploymentId: state.current.deploymentId, images: images(state.current.images), configurationHash: state.current.configurationHash, ossGitSha: state.current.ossGitSha, verified: state.current.verified },
    target: state.target ? { images: images(state.target.images), ossGitSha: state.target.ossGitSha } : null,
    checkedAt: state.kind === "unknown" && !state.current.verified ? null : state.checkedAt, stale: expired || state.stale };
}
