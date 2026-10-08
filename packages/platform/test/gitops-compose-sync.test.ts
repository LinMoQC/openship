import { describe, expect, it } from "vitest";
import { composeSpecsEqual, composeWritePatch, toComposeSpec } from "@repo/db";
import { parseComposeFile, inferComposeEnvironmentTemplates } from "../src/engine/lib/compose-parser";
import { gitopsComposeServiceInputs } from "../src/gitops-compose";

const image = `ghcr.io/fixture/service@sha256:${"a".repeat(64)}`;
const document = `services:
  no-environment:
    image: ${image}
    command: ["sh", "-c", "echo ready && exit 0"]
  empty-environment:
    image: ${image}
    environment: {}
  literals:
    image: ${image}
    environment: { LITERAL: value, ESCAPED: "$$LITERAL" }
  templates:
    image: ${image}
    environment: { SECRET: "\${SECRET:?required}", DEFAULT: "\${OPTIONAL:-fallback}" }
`;

function synced(source: ReturnType<typeof gitopsComposeServiceInputs>[number]) {
  // The actual generic sync writer first makes parser provenance explicit, then
  // persists through composeWritePatch. Match that seam, including the service
  // without an environment declaration that triggered the real 409.
  const marker = Object.hasOwn(source.advanced ?? {}, "environmentTemplateKeys");
  const templates = source.environmentTemplates ?? (marker
    ? Object.fromEntries((source.advanced?.environmentTemplateKeys ?? []).map(key => [key, source.environment[key]!]))
    : inferComposeEnvironmentTemplates(source.environment));
  return composeWritePatch({ ...source, environmentTemplates: templates }, { advanced: { readiness: { enabled: true } } }, true);
}

describe("GitOps Compose sync and execution parity", () => {
  it.each(["no-environment", "empty-environment", "literals", "templates"])("accepts the unchanged synchronized %s service", name => {
    const inputs = gitopsComposeServiceInputs(parseComposeFile(document, { env: { SECRET: "fixture-secret" } }).services);
    const input = inputs.find(service => service.name === name)!;
    const stored = synced(input);
    expect(composeSpecsEqual(toComposeSpec(stored), composeWritePatch(input, stored, true))).toBe(true);
    expect(stored.advanced.readiness).toEqual({ enabled: true });
    expect(input).not.toHaveProperty("environmentMeta");
  });

  it("still refuses changed images, commands, mounts, ports and environment expressions", () => {
    const [input] = gitopsComposeServiceInputs(parseComposeFile(document, { env: { SECRET: "fixture-secret" } }).services);
    const stored = synced(input!);
    for (const changed of [
      { ...input!, image: image.replace("a".repeat(64), "b".repeat(64)) },
      { ...input!, command: "changed", commandArgv: ["changed"] },
      { ...input!, volumes: ["other:/data"] },
      { ...input!, ports: ["9001:80"] },
      { ...input!, environment: { EXTRA: "\${EXTRA}" }, environmentTemplates: { EXTRA: "\${EXTRA}" } },
    ]) expect(composeSpecsEqual(toComposeSpec(stored), composeWritePatch(changed, stored, true))).toBe(false);
  });
});
