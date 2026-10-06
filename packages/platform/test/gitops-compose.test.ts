import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { gitopsConfigurationHash, renderGitopsCompose, selectedImageExpectations } from "../src/gitops-compose";
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
});
