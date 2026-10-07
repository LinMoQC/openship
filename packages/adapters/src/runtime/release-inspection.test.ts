import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalRegistryImage, inspectRegistryImage } from "./release-inspection";
const child = `sha256:${"a".repeat(64)}`;
const body = JSON.stringify({ manifests: [{ digest: child, platform: { os: "linux", architecture: "amd64" } }] });
const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
const manifest = () => new Response(body, { headers: { "docker-content-digest": digest } });
const configBody = JSON.stringify({ os: "linux", architecture: "amd64" });
const configDigest = `sha256:${createHash("sha256").update(configBody).digest("hex")}`;
const singleBody = JSON.stringify({ config: { digest: configDigest } });
const singleDigest = `sha256:${createHash("sha256").update(singleBody).digest("hex")}`;
const singleManifest = () => new Response(singleBody, { headers: { "docker-content-digest": singleDigest } });
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
  it("attests a GHCR config blob redirected to GitHub storage without forwarding credentials", async () => {
    const signedUrl = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/config?signature=fixture";
    const f = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' } }))
      .mockResolvedValueOnce(Response.json({ token: "private-token" }))
      .mockResolvedValueOnce(singleManifest())
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: signedUrl } }))
      .mockResolvedValueOnce(new Response(configBody));
    expect(await inspectRegistryImage(`ghcr.io/magic/app@${singleDigest}`, "amd64", { username: "u", password: "s" }, f)).toEqual({ digest: singleDigest, architecture: "amd64" });
    expect(new Headers(f.mock.calls[3]![1]?.headers).get("Authorization")).toBe("Bearer private-token");
    expect(f.mock.calls[4]![0]).toBe(signedUrl);
    expect(new Headers(f.mock.calls[4]![1]?.headers).has("Authorization")).toBe(false);
    expect(f.mock.calls[4]![1]?.redirect).toBe("manual");
  });
  it.each([
    "http://pkg-containers.githubusercontent.com/config",
    "https://pkg-containers.githubusercontent.com.attacker.example/config",
    "https://user:secret@pkg-containers.githubusercontent.com/config",
    "https://pkg-containers.githubusercontent.com:8443/config",
    "https://127.0.0.1/config",
  ])("rejects an untrusted blob redirect %s before sending a request", async location => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(singleManifest())
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location } }));
    await expect(inspectRegistryImage(`ghcr.io/magic/app@${singleDigest}`, "amd64", undefined, f)).rejects.toThrow("redirect");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("still rejects corrupt redirected config bytes", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(singleManifest())
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://pkg-containers.githubusercontent.com/config" } }))
      .mockResolvedValueOnce(new Response("{}"));
    await expect(inspectRegistryImage(`ghcr.io/magic/app@${singleDigest}`, "amd64", undefined, f)).rejects.toThrow("digest");
  });
  it("bounds redirect loops and strips auth on every storage hop", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(singleManifest())
      .mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://pkg-containers.githubusercontent.com/config" } }));
    await expect(inspectRegistryImage(`ghcr.io/magic/app@${singleDigest}`, "amd64", { username: "u", password: "s" }, f)).rejects.toThrow("Too many");
    expect(f).toHaveBeenCalledTimes(5);
    for (const [, init] of f.mock.calls.slice(2)) expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });
  it("does not extend GHCR storage trust to another registry", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(singleManifest())
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://pkg-containers.githubusercontent.com/config" } }));
    await expect(inspectRegistryImage(`registry.example/magic/app@${singleDigest}`, "amd64", undefined, f)).rejects.toThrow("Untrusted");
    expect(f).toHaveBeenCalledTimes(2);
  });
});
