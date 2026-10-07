export interface ReleaseHostConfiguration { root: string; files: Record<string, string> }
export interface HostConfigurationReader {
  inspectReleaseHostConfiguration(root: string, files: string[]): Promise<Record<string, string>>;
}

export async function inspectBoundHostConfiguration(reader: HostConfigurationReader, stack: string, config: ReleaseHostConfiguration) {
  if (stack !== "magic-core" || !/^\/root\/magic-deploy-config-runtime\/core-config\/[a-f0-9]{16}$/.test(config.root)) throw new Error("Host configuration is outside the bound scope");
  // The controller stages the contents of this repository directory directly
  // inside the immutable root. Keep logical keys in the release hash/contract.
  const prefix = "stacks/magic-core/deploy/";
  const logical = Object.keys(config.files);
  if (!logical.length || logical.length > 128) throw new Error("Invalid host configuration inventory");
  const paths = logical.map(name => {
    const relative = name.slice(prefix.length);
    if (!name.startsWith(prefix) || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(relative) || relative.split("/").some(part => part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(config.files[name]!)) throw new Error("Invalid bound configuration path or digest");
    return relative;
  });
  const hashes = await reader.inspectReleaseHostConfiguration(config.root, paths);
  if (Object.keys(hashes).length !== paths.length || paths.some(path => !/^[a-f0-9]{64}$/.test(hashes[path] ?? ""))) throw new Error("Host configuration hashes are incomplete");
  return Object.fromEntries(logical.map((name, index) => [name, hashes[paths[index]!]!]));
}
