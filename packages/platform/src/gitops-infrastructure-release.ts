import { AppError } from "@repo/core";

export interface InfrastructureReleaseSpec {
  name: string; image: string;
  release?: { repository: string; versions: Record<string, { gitSha: string; digest: string }> };
}

/** External images require an exact version/source/digest tuple reviewed on main. */
export function approvedInfrastructureRelease(specs: InfrastructureReleaseSpec[] | undefined, payload: Record<string, unknown>): InfrastructureReleaseSpec | null {
  const spec = specs?.find(s => s.name === payload.service);
  if (!spec) return null;
  const version = spec.release?.versions[String(payload.tag)];
  if (!spec.release || !version || payload.repository !== spec.release.repository || payload.image !== spec.image
    || payload.gitSha !== version.gitSha || payload.digest !== version.digest || payload.migrationsChanged !== false
    || !/^[a-f0-9]{40}$/.test(version.gitSha) || !/^sha256:[a-f0-9]{64}$/.test(version.digest))
    throw new AppError("Infrastructure release differs from the reviewed version, source or digest", 409, "RELEASE_SOURCE_INVALID");
  return spec;
}
