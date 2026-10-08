import { describe, expect, it } from "vitest";
import { observedManifestContract } from "../src/gitops-observed-manifest";
import incumbent from "./fixtures/core-incumbent-13.json";

const digest = "sha256:" + "a".repeat(64);
const stack = { expectedServices: ["platform-api", "migrate", "redis", "redpanda"],
  services: [{ name: "platform-api", image: "ghcr.io/example/api" }],
  infrastructure: [{ name: "redis", image: "redis" }, { name: "redpanda", image: "redpanda" }] };
const image = (name: string) => ({ image: name, digest });
const manifest = { services: { "platform-api": image("ghcr.io/example/api") }, infrastructure: { redis: image("redis") } };
const locked = { services: {
  "platform-api": { image: "ghcr.io/example/api@" + digest },
  migrate: { image: "ghcr.io/example/api@" + digest },
  redis: { image: "redis@" + digest },
} };

describe("incumbent manifest scope", () => {
  it("reads the exact established 13-service Core lock against the 16-service target contract", () => {
    const observed = observedManifestContract(incumbent.stack, incumbent.manifest, incumbent.locked);
    expect(observed.expectedServices).toHaveLength(13);
    expect(observed.services).toHaveLength(6);
    expect(observed.infrastructure).toHaveLength(6);
    expect(observed.expectedServices).toContain("migrate");
    expect(incumbent.stack.expectedServices).toHaveLength(16);
    expect(observed.expectedServices).not.toContain("redpanda");
    expect(observed.expectedServices).not.toContain("redpanda-init");
    expect(observed.expectedServices).not.toContain("interview-agent");
  });
  it("validates the observed smaller incumbent without treating it as the expanded target", () => {
    const observed = observedManifestContract(stack, manifest, locked);
    expect(observed.expectedServices).toEqual(["platform-api", "migrate", "redis"]);
    expect(observed.infrastructure).toEqual([stack.infrastructure[0]]);
    expect(stack.expectedServices).toContain("redpanda");
    expect(stack.infrastructure).toHaveLength(2);
  });
  it("rejects missing manifest images, mutable locks and wrong inherited migration images", () => {
    expect(() => observedManifestContract(stack, { ...manifest, infrastructure: {} }, locked)).toThrow(/immutable locked Compose/);
    for (const name of ["platform-api", "migrate", "redis"]) {
      const bad = structuredClone(locked);
      bad.services[name as keyof typeof bad.services].image = "redis:latest";
      expect(() => observedManifestContract(stack, manifest, bad)).toThrow(/immutable locked Compose/);
    }
  });
  it("does not accept extra images or an unconfigured service even when their digests match", () => {
    expect(() => observedManifestContract(stack, { ...manifest, infrastructure: { ...manifest.infrastructure, extra: image("extra") } }, locked)).toThrow(/immutable locked Compose/);
    expect(() => observedManifestContract(stack, manifest, { services: { ...locked.services, extra: { image: "extra@" + digest } } })).toThrow(/immutable locked Compose/);
    expect(() => observedManifestContract(stack, manifest, null)).toThrow(/immutable locked Compose/);
  });
});
