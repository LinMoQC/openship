import { compareSemver } from "./semver";

/** A custom commit is provenance, not an upstream prerelease waiting to be
 * replaced by an ordinary installer. Only a separately verified matched bundle
 * may upgrade this control platform. */
export function magicRuntimeBaseline(version: string): string | null {
  return /^v?(\d+\.\d+\.\d+)-magic\.[a-f0-9]{12}$/i.exec(version)?.[1] ?? null;
}
export function customRuntimeUpdatePolicy(current: string, latest: string | null) {
  const baseline = magicRuntimeBaseline(current);
  return baseline ? { customRuntime: true as const, adaptationRequired: Boolean(latest && compareSemver(latest, baseline) > 0) } : null;
}
