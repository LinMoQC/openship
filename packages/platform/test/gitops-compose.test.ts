import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { gitopsConfigurationHash, observedGitopsConfigurationHash, renderGitopsCompose, selectedImageExpectations } from "../src/gitops-compose";
import type { ReleaseCheck } from "@repo/contracts";
const digest = `sha256:${"a".repeat(64)}`;
const manifest = { services: { "platform-api": { image: "ghcr.io/magic/api", digest } }, infrastructure: { postgres: { image: "pgvector/pgvector", digest } } };
const template = 'services:\n  platform-api:\n    image: placeholder\n    ports: ["${API_PORT}:3000"]\n    environment: { SECRET: "${SECRET:?required}" }\n  migrate:\n    image: placeholder\n    command: migrate\n  postgres:\n    image: placeholder\n';
describe("frozen GitOps Compose", () => {
  it("includes a selected completion job's explicit image in acceptance and refuses an unproven job", () => {
    const images = { "platform-api": { image: 'ghcr.io/magic/api', digest, gitSha: 'a'.repeat(40) } };
    expect(selectedImageExpectations(images, [{ name: 'migrate', image: `ghcr.io/magic/api@${digest}` }], ['migrate']).migrate).toEqual(images['platform-api']);
    expect(selectedImageExpectations(images, [], [])).toEqual(images);
    expect(() => selectedImageExpectations(images, [{ name: 'migrate', image: 'ghcr.io/magic/api:latest' }], ['migrate'])).toThrow(/provenance/);
  });
  it("locks application, migration job and infrastructure images while retaining server interpolation", () => {
    const result = YAML.parse(renderGitopsCompose(template, { expectedServices: ["migrate", "postgres", "platform-api"] }, manifest));
    expect(result.services.migrate.image).toBe(`ghcr.io/magic/api@${digest}`); expect(result.services.postgres.image).toBe(`pgvector/pgvector@${digest}`); expect(result.services['platform-api'].environment.SECRET).toBe('${SECRET:?required}');
  });
  it("detects changes in ports, host config and service scope", () => {
    const stack = { expectedServices: ["migrate", "postgres", "platform-api"] };
    expect(gitopsConfigurationHash(template, stack)).not.toBe(gitopsConfigurationHash(template.replace('3000', '4000'), stack));
    expect(gitopsConfigurationHash(template, stack)).not.toBe(gitopsConfigurationHash(template, { ...stack, hostConfig: { root: '/root/magic-deploy-config-runtime/core-config/aaaaaaaaaaaaaaaa', files: {} } }));
    expect(() => renderGitopsCompose(template, { expectedServices: ['platform-api'] }, manifest)).toThrow();
  });
  describe("legacy PRT host configuration observation", () => {
    const stack = { expectedServices: ["migrate", "postgres", "platform-api"] };
    const targetStack = { ...stack, hostConfig: { root: '/root/magic-deploy-config-runtime/core-config/aaaaaaaaaaaaaaaa', files: { 'stacks/magic-core/deploy/nginx.conf': 'a'.repeat(64) } } };
    const imageServices = ['platform-api', 'postgres'];
    const checks: ReleaseCheck[] = ['configuration.files', ...imageServices.flatMap(name => [`topology.${name}`, `target.topology.${name}`, `runtime.${name}`])]
      .map(key => ({ key, label: key, status: 'pass', detail: 'verified actual host', blocking: true }));
    const input = { preview: true, template, stack, targetTemplate: template, targetStack, imageServices, checks };
    const original = gitopsConfigurationHash(template, stack);
    it("recognizes already-mounted files only after live files and both topology proofs pass", () => {
      expect(observedGitopsConfigurationHash(input)).toBe(gitopsConfigurationHash(template, targetStack));
      expect(original).not.toBe(gitopsConfigurationHash(template, targetStack));
      expect(stack).not.toHaveProperty('hostConfig');
    });
    it.each(['configuration.files', 'topology.platform-api', 'target.topology.platform-api', 'runtime.platform-api', 'topology.postgres', 'target.topology.postgres', 'runtime.postgres'])("retains the original hash when %s is unknown, failed, absent or duplicated", key => {
      for (const status of ['unknown', 'fail'] as const) expect(observedGitopsConfigurationHash({ ...input, checks: checks.map(check => check.key === key ? { ...check, status } : check) })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, checks: checks.filter(check => check.key !== key) })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, checks: [...checks, checks.find(check => check.key === key)!] })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, checks: checks.map(check => check.key === key ? { ...check, blocking: false } : check) })).toBe(original);
    });
    it("never adopts metadata for production, changed Compose, changed scope or unverified images", () => {
      expect(observedGitopsConfigurationHash({ ...input, preview: false })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, targetTemplate: template.replace('3000', '4000') })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, targetStack: { ...targetStack, expectedServices: [...stack.expectedServices, 'extra'] } })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, imageServices: [] })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, imageServices: [...imageServices, 'extra'] })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, imageServices: [...imageServices, 'postgres'] })).toBe(original);
      expect(observedGitopsConfigurationHash({ ...input, targetStack: { ...targetStack, hostConfig: { ...targetStack.hostConfig, files: {} } } })).toBe(original);
    });
    it("retains an existing host contract so changed files or roots remain a real difference", () => {
      const existing = { ...targetStack, hostConfig: { ...targetStack.hostConfig, root: '/root/magic-deploy-config-runtime/core-config/bbbbbbbbbbbbbbbb' } };
      expect(observedGitopsConfigurationHash({ ...input, stack: existing })).toBe(gitopsConfigurationHash(template, existing));
      expect(observedGitopsConfigurationHash({ ...input, stack: existing })).not.toBe(gitopsConfigurationHash(template, targetStack));
    });
  });
});
