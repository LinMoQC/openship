import { AppError } from "@repo/contracts";
import YAML from "yaml";
import { releaseHash } from "./releases";
import type { ReleaseImage } from "@repo/contracts";

/** Completion jobs such as Core's migrate are not independent release images.
 * Attest a selected job through its explicit immutable Compose image instead
 * of omitting it from final acceptance or inventing a separate source version. */
export function selectedImageExpectations(images: Record<string, ReleaseImage>, compose: Array<{ name: string; image?: string }>, selected: string[]): Record<string, ReleaseImage> {
  const result = { ...images };
  for (const name of selected) {
    if (result[name]) continue;
    const configured = compose.find(service => service.name === name);
    const source = Object.values(images).find(image => configured?.image === `${image.image}@${image.digest}`);
    if (!source) throw new AppError("Selected service has no explicit immutable Compose image provenance", 409, "RELEASE_EXECUTION_TARGET_MISMATCH");
    result[name] = { ...source };
  }
  return result;
}
export interface GitopsComposeContract {
  expectedServices: string[];
  hostConfig?: { root: string; files: Record<string, string> };
}
export function gitopsConfigurationHash(template: string, stack: GitopsComposeContract) {
  return releaseHash({ template, expectedServices: [...stack.expectedServices].sort(), hostConfig: stack.hostConfig ?? null });
}
/** Reproduce the controller's locked document without reading or exporting server variables. */
export function renderGitopsCompose(template: string, stack: GitopsComposeContract, manifest: unknown): string {
  const invalid = (): never => { throw new AppError("GitOps Compose does not match the frozen template and image contract", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH"); };
  const doc = YAML.parse(template) as { services?: Record<string, Record<string, unknown>> };
  const releases = manifest as { services?: Record<string, { image: string; digest: string }>; infrastructure?: Record<string, { image: string; digest: string }> };
  if (!doc?.services || releaseHash(Object.keys(doc.services).sort()) !== releaseHash([...stack.expectedServices].sort())) invalid();
  for (const [name, release] of Object.entries({ ...releases.services, ...releases.infrastructure })) {
    if (!doc.services![name] || !/^sha256:[a-f0-9]{64}$/.test(release.digest)) invalid();
    doc.services![name]!.image = `${release.image}@${release.digest}`;
    if (name === "platform-api" && doc.services!.migrate) doc.services!.migrate.image = `${release.image}@${release.digest}`;
  }
  for (const service of Object.values(doc.services!)) {
    if (service.build || typeof service.image !== "string" || !/^.+@sha256:[a-f0-9]{64}$/.test(service.image)) invalid();
    if (stack.hostConfig) {
      if (!/^\/root\/magic-deploy-config-runtime\/core-config\/[a-f0-9]{16}$/.test(stack.hostConfig.root)) invalid();
      const marker = '${CORE_CONFIG_ROOT:?CORE_CONFIG_ROOT is required}';
      service.volumes = ((service.volumes ?? []) as unknown[]).map(mount => typeof mount === "string" && mount.startsWith(marker) ? stack.hostConfig!.root + mount.slice(marker.length) : mount);
    }
  }
  return YAML.stringify(doc, { lineWidth: 0 });
}
