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
  async function request(url: string, blob = false): Promise<Response> {
    const redirect = blob ? "manual" : "error";
    const response = await fetchImpl(url, { redirect, signal: AbortSignal.timeout(10_000), headers: { Accept: accept, ...(authorization ? { Authorization: authorization } : {}) } });
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
    return fetchImpl(url, { redirect, signal: AbortSignal.timeout(10_000), headers: { Accept: accept, Authorization: authorization } });
  }
  async function configBlob(url: string): Promise<Response> {
    let response = await request(url, true);
    const signal = AbortSignal.timeout(10_000);
    for (let hops = 0; [301, 302, 303, 307, 308].includes(response.status); hops++) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (hops >= 3) throw new Error("Too many registry blob redirects");
      const target = location ? new URL(location, url) : null;
      // GHCR serves private config blobs from signed GitHub storage URLs.
      // Only that storage host may receive a redirected GET, and
      // no registry Basic/Bearer credential is forwarded outside the registry.
      if (host !== "ghcr.io" || !target || target.protocol !== "https:" || target.hostname !== "pkg-containers.githubusercontent.com" || target.port || target.username || target.password)
        throw new Error("Untrusted registry blob redirect");
      url = target.href;
      response = await fetchImpl(url, { redirect: "manual", signal, headers: { Accept: accept } });
    }
    return response;
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
    const config = await configBlob(`${origin}/v2/${repository}/blobs/${manifest.config!.digest}`);
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
  // An image VOLUME creates an anonymous mount even when Compose has no
  // volumes. Only attest Docker's implicit, local, writable mounts when there
  // is no caller-supplied mount or inherited container volume at all.
  const noRequestedMounts = !(container.HostConfig.Binds?.length || container.HostConfig.Mounts?.length || container.HostConfig.VolumesFrom?.length || Object.keys(container.HostConfig.Tmpfs ?? {}).length);
  const implicitImageMounts = noRequestedMounts ? container.Mounts.filter(m =>
    m.Type === "volume" && m.Driver === "local" && m.RW === true && !m.Mode && /^[a-f0-9]{64}$/.test(m.Name ?? "") &&
    Object.hasOwn(actual.Config.Volumes ?? {}, m.Destination) && Object.hasOwn(container.Config.Volumes ?? {}, m.Destination)
  ).map(m => ({ source: m.Name!, target: m.Destination, readOnly: false, type: "volume" })) : [];
  return { image, digest, imageId: container.Image, running: container.State.Running,
    projectId: container.Config.Labels?.["openship.project"] ?? null,
    serviceName: container.Config.Labels?.["openship.service"] ?? null,
    deploymentId: container.Config.Labels?.["openship.deployment"] ?? null,
    command: container.Config.Cmd ?? null, entrypoint: container.Config.Entrypoint ?? null,
    networkMode: container.HostConfig.NetworkMode ?? "", pidMode: container.HostConfig.PidMode ?? "",
    health: container.State.Health?.Status ?? null, exitCode: container.State.ExitCode, ports: container.HostConfig.PortBindings ?? {},
    networks: Object.keys(container.NetworkSettings.Networks ?? {}).sort(),
    mounts: container.Mounts.map(m => ({ source: m.Name ?? m.Source, target: m.Destination, readOnly: !m.RW, type: m.Type })),
    implicitImageMounts,
  };
}
