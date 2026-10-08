import { AppError } from "@repo/contracts";
import YAML from "yaml";
import { releaseHash } from "./releases";
import type { ReleaseImage } from "@repo/contracts";
import type { ReleaseCheck } from "@repo/contracts";
import type { ComposeService } from "./engine/lib/compose-parser";

/** Canonical parser provenance for both the server-side sync writer and its
 * execution gate. The generic writer infers an empty template map for services
 * without an environment declaration; freeze that same explicit map when
 * verifying the stored result instead of comparing it with an absent marker. */
export function gitopsComposeServiceInputs(services: readonly ComposeService[]) {
  return services.map(({ environmentMeta: _meta, ...service }) => ({
    ...service,
    environmentTemplates: service.environmentTemplates ?? {},
  }));
}

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
/** A legacy PRT deployment can predate hostConfig metadata while already using
 * exactly those files and mounts. Observe that configuration through current
 * file and both incumbent/target topology proofs; never rewrite its deployment
 * commit or turn a real configuration change into a no-op. */
export function observedGitopsConfigurationHash(input: {
  preview: boolean;
  template: string;
  stack: GitopsComposeContract;
  targetTemplate: string;
  targetStack: GitopsComposeContract;
  imageServices: string[];
  checks: ReleaseCheck[];
}) {
  const { template, stack, targetTemplate, targetStack, imageServices, checks } = input;
  const original = gitopsConfigurationHash(template, stack);
  if (!input.preview || stack.hostConfig || !targetStack.hostConfig || !Object.keys(targetStack.hostConfig.files).length ||
      template !== targetTemplate || releaseHash([...stack.expectedServices].sort()) !== releaseHash([...targetStack.expectedServices].sort()) ||
      !imageServices.length || new Set(imageServices).size !== imageServices.length) return original;
  const passed = (key: string) => {
    const evidence = checks.filter(check => check.key === key);
    return evidence.length === 1 && evidence[0]!.blocking && evidence[0]!.status === "pass";
  };
  if (!passed("configuration.files") || !imageServices.every(name =>
      passed(`topology.${name}`) && passed(`target.topology.${name}`) && passed(`runtime.${name}`))) return original;
  return gitopsConfigurationHash(template, targetStack);
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
