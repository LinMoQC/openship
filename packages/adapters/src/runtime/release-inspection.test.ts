import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalRegistryImage, inspectRegistryImage } from "./release-inspection";
const child = `sha256:${"a".repeat(64)}`;
const body = JSON.stringify({ manifests: [{ digest: child, platform: { os: "linux", architecture: "amd64" } }] });
const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
const manifest = () => new Response(body, { headers: { "docker-content-digest": digest } });
describe("registry release attestation", () => {
  it("normalizes short Docker Hub and fully qualified names", () => {
    expect(canonicalRegistryImage("nginx").canonical).toBe("docker.io/library/nginx");
    expect(canonicalRegistryImage("pgvector/pgvector").repository).toBe("pgvector/pgvector");
    expect(canonicalRegistryImage("ghcr.io/magic/app").host).toBe("ghcr.io");
  });
  it("verifies immutable manifest bytes and matching host architecture", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(manifest());
    expect(await inspectRegistryImage(`ghcr.io/magic/app@${digest}`, "x86_64", undefined, f)).toEqual({ digest, architecture: "amd64" });
    const f2 = vi.fn<typeof fetch>().mockResolvedValueOnce(manifest());
    await expect(inspectRegistryImage(`ghcr.io/magic/app@${digest}`, "arm64", undefined, f2)).rejects.toThrow("architecture");
  });
  it("supports Docker Hub's authenticated pull realm", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } })).mockResolvedValueOnce(Response.json({ token: "private-token" })).mockResolvedValueOnce(manifest());
    await inspectRegistryImage(`nginx@${digest}`, "amd64", undefined, f);
    expect(String(f.mock.calls[1]![0])).toContain("scope=repository%3Alibrary%2Fnginx%3Apull");
  });
  it("does not send registry credentials to a foreign authentication origin", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://attacker.example/token"' } }));
    await expect(inspectRegistryImage(`ghcr.io/magic/app@${digest}`, "amd64", { username: "u", password: "s" }, f)).rejects.toThrow("Untrusted"); expect(f).toHaveBeenCalledOnce();
  });
  it("rejects a lying content-digest header and mutable image references", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { headers: { "docker-content-digest": digest } }));
    await expect(inspectRegistryImage(`ghcr.io/magic/app@${digest}`, "amd64", undefined, f)).rejects.toThrow("bytes");
    await expect(inspectRegistryImage("ghcr.io/magic/app:latest", "amd64", undefined, f)).rejects.toThrow("immutable");
  });
});
