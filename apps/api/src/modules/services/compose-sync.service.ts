import { repos } from "@repo/db";
import { ValidationError } from "@repo/core";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { decrypt } from "../../lib/encryption";
import { blockingComposeFields, parseComposeFile } from "../../lib/compose-parser";
import { maskServicesEnv } from "../../lib/secret-env";
import type { RequestContext } from "../../lib/request-context";
import type { TSyncComposeDocumentBody } from "./service.schema";
import { syncComposeServices } from "./service.service";

/** CI sends the locked source; project secrets are resolved only inside the API. */
export async function syncComposeDocument(
  ctx: RequestContext,
  projectId: string,
  input: TSyncComposeDocumentBody,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (project.environmentType !== input.environment || project.hasBuild !== false) {
    throw new ValidationError("Compose sync requires the matching prebuilt project environment");
  }
  const expected = [...input.expectedServices].sort();
  if (!expected.length || new Set(expected).size !== expected.length) {
    throw new ValidationError("Expected service names must be nonempty and unique");
  }
  const env: Record<string, string> = {};
  // null selects project variables, excluding per-service overrides.
  for (const row of await repos.project.listEnvVars(projectId, input.environment, null)) {
    try {
      env[row.key] = decrypt(row.value);
    } catch {
      throw new ValidationError("A stored project variable could not be decrypted");
    }
  }
  let parsed: ReturnType<typeof parseComposeFile>;
  try {
    parsed = parseComposeFile(input.compose, { env });
  } catch {
    // YAML exceptions may include source text; never return them to CI.
    throw new ValidationError("Invalid Compose document");
  }
  const actual = parsed.services.map((service) => service.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ValidationError("Compose service set does not match the complete expected set");
  }
  if (parsed.missingRequired.length || blockingComposeFields(parsed.unsupported).length) {
    throw new ValidationError("Compose has missing required variables or unsupported runtime fields");
  }
  if (parsed.services.some((service) => service.build || !/^.+@sha256:[a-f0-9]{64}$/.test(service.image ?? ""))) {
    throw new ValidationError("Every service must use a prebuilt image pinned by digest");
  }
  const stored = await repos.service.listByProject(projectId);
  if (stored.some((service) => !expected.includes(service.name))) {
    throw new ValidationError("Compose sync would remove an existing service; reconcile explicitly first");
  }
  const services = parsed.services.map(({ environmentMeta: _meta, ...service }) => service);
  const rows = await syncComposeServices(ctx, projectId, services);
  return maskServicesEnv(rows.filter((row) => row != null));
}
