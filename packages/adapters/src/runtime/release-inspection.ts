import { createHash } from "node:crypto";
import type Dockerode from "dockerode";
const accept = "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json";
/** Docker's canonical repository spelling, including short Docker Hub names. */
export function canonicalRegistryImage(image: string) {
  const name = image.split("@")[0]!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:\-]*$/.test(name) || name.includes("..")) throw new Error("Invalid image repository");
  const parts = name.split("/");
  const explicit = parts.length > 1 && /[.:]/.test(parts[0]!);
  const host = explicit ? parts.shift()! : "docker.io";
  const repository = parts.length === 1 && ["docker.io", "index.docker.io", "registry-1.docker.io"].includes(host) ? `library/${parts[0]}` : parts.join("/");
  const dockerHub = ["docker.io", "index.docker.io", "registry-1.docker.io"].includes(host);
  return { host: dockerHub ? "registry-1.docker.io" : host, repository, canonical: `${dockerHub ? "docker.io" : host}/${repository}`, dockerHub };
}
/** Read-only verification; neither credentials nor registry response bodies cross this boundary. */
export async function inspectRegistryImage(ref: string, architecture: string, auth: Dockerode.AuthConfig | undefined, fetchImpl: typeof fetch = fetch) {
  const match = /^(.+)@(sha256:[a-f0-9]{64})$/.exec(ref);
  if (!match) throw new Error("An immutable registry image is required");
  const { host, repository, dockerHub } = canonicalRegistryImage(match[1]!);
  const digest = match[2]!;
  if (host === "localhost" || host.endsWith(".local") || /^[0-9.]+(:[0-9]+)?$/.test(host)) throw new Error("Private-address registries require an explicit trusted registry adapter");
  const origin = `https://${host}`;
  const basic = auth && "username" in auth && auth.username && auth.password ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` : undefined;
  let authorization = basic;
  async function request(url: string): Promise<Response> {
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: accept, ...(authorization ? { Authorization: authorization } : {}) } });
    if (response.status !== 401) return response;
    const challenge = response.headers.get("www-authenticate") ?? "";
    const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
    if (!/^Bearer\s/i.test(challenge) || !realm) return response;
    const tokenUrl = new URL(realm);
    if (tokenUrl.protocol !== "https:" || tokenUrl.username || tokenUrl.password || (tokenUrl.origin !== origin && !(dockerHub && tokenUrl.origin === "https://auth.docker.io"))) throw new Error("Untrusted registry authentication realm");
    tokenUrl.searchParams.set("service", /service="([^"]+)"/.exec(challenge)?.[1] ?? host);
    tokenUrl.searchParams.set("scope", `repository:${repository}:pull`);
    const tokenResponse = await fetchImpl(tokenUrl, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: basic ? { Authorization: basic } : {} });
    if (!tokenResponse.ok) throw new Error("Registry pull permission could not be verified");
    const data = await tokenResponse.json() as { token?: string; access_token?: string };
    const token = data.token ?? data.access_token;
    if (!token) throw new Error("Registry returned no pull token");
    authorization = `Bearer ${token}`;
    return fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: accept, Authorization: authorization } });
  }
  const response = await request(`${origin}/v2/${repository}/manifests/${digest}`);
  if (!response.ok || response.headers.get("docker-content-digest") !== digest) throw new Error("Registry image does not exist, digest differs, or pull permission is missing");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) throw new Error("Registry manifest bytes do not match the requested digest");
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { manifests?: Array<{ platform?: { architecture?: string; os?: string }; digest?: string }>; config?: { digest?: string } };
  const arch = architecture === "x86_64" ? "amd64" : architecture === "aarch64" ? "arm64" : architecture;
  if (manifest.manifests) {
    if (!manifest.manifests.some(m => m.platform?.os === "linux" && m.platform.architecture === arch && /^sha256:[a-f0-9]{64}$/.test(m.digest ?? ""))) throw new Error("Image architecture does not match the deployment host");
  } else {
    if (!/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest ?? "")) throw new Error("Registry image config is unavailable");
    const config = await request(`${origin}/v2/${repository}/blobs/${manifest.config!.digest}`);
    if (!config.ok) throw new Error("Registry image config is unavailable");
    const configBytes = new Uint8Array(await config.arrayBuffer());
    if (`sha256:${createHash("sha256").update(configBytes).digest("hex")}` !== manifest.config!.digest) throw new Error("Registry image config digest differs");
    const data = JSON.parse(new TextDecoder().decode(configBytes)) as { architecture?: string; os?: string };
    if (data.os !== "linux" || data.architecture !== arch) throw new Error("Image architecture does not match the deployment host");
  }
  return { digest, architecture: arch };
}
export async function inspectContainerImage(docker: Dockerode, id: string, image: string) {
  const container = await docker.getContainer(id).inspect();
  const actual = await docker.getImage(container.Image).inspect();
  const repository = canonicalRegistryImage(image).canonical;
  const ref = actual.RepoDigests?.find(d => canonicalRegistryImage(d).canonical === repository);
  const digest = ref?.split("@")[1];
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Runtime image has no verifiable repository digest");
  return { image, digest, imageId: container.Image, running: container.State.Running,
    projectId: container.Config.Labels?.["openship.project"] ?? null,
    networkMode: container.HostConfig.NetworkMode ?? "", pidMode: container.HostConfig.PidMode ?? "",
    health: container.State.Health?.Status ?? null, exitCode: container.State.ExitCode, ports: container.HostConfig.PortBindings ?? {},
    networks: Object.keys(container.NetworkSettings.Networks ?? {}).sort(),
    mounts: container.Mounts.map(m => ({ source: m.Name ?? m.Source, target: m.Destination, readOnly: !m.RW, type: m.Type })),
  };
}
