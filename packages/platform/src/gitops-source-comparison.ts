import { AppError } from "@repo/core";

interface SourceComparison { status: string; total_commits: number; files: Array<{ filename: string }>; }
type Read = (path: string) => Promise<unknown>;
const shaPattern = /^[a-f0-9]{40}$/;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function reject(): never {
  throw new AppError("Source ancestry or complete change scope cannot be verified", 409, "RELEASE_SOURCE_INVALID");
}
async function treeIdentity(read: Read, commitSha: string): Promise<string> {
  const commit = object(await read(`git/commits/${commitSha}`));
  const treeSha = object(commit.tree).sha;
  if (commit.sha !== commitSha || typeof treeSha !== "string" || !shaPattern.test(treeSha)) reject();
  return treeSha;
}
async function treeFiles(read: Read, treeSha: string): Promise<Map<string, string>> {
  const tree = object(await read(`git/trees/${treeSha}?recursive=1`));
  if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 100_000) reject();
  const seen = new Set<string>(), files = new Map<string, string>();
  for (const value of tree.tree) {
    const row = object(value), path = row.path;
    if (typeof path !== "string" || !path || path.includes("\0") || path.startsWith("/") || path.split("/").some(x => x === "." || x === "..") || seen.has(path)
      || typeof row.sha !== "string" || !shaPattern.test(row.sha) || typeof row.mode !== "string" || !/^[0-7]{6}$/.test(row.mode)
      || !["blob", "tree", "commit"].includes(String(row.type))) reject();
    seen.add(path);
    if (row.type !== "tree") files.set(path, `${row.type}/${row.mode}/${row.sha}`);
  }
  return files;
}
export async function verifiedSourceComparison(read: Read, previous: string, next: string): Promise<SourceComparison> {
  if (!shaPattern.test(previous) || !shaPattern.test(next)) reject();
  const compare = object(await read(`compare/${previous}...${next}`));
  if (!["ahead", "identical"].includes(String(compare.status)) || !Number.isSafeInteger(compare.total_commits)
    || Number(compare.total_commits) < 0 || Number(compare.total_commits) >= 250 || !Array.isArray(compare.files)) reject();
  let files: Array<{ filename: string }>;
  if (compare.files.length < 300) {
    files = compare.files.flatMap(value => {
      const row = object(value);
      if (typeof row.filename !== "string" || !row.filename || (row.previous_filename !== undefined && typeof row.previous_filename !== "string")) reject();
      return [row.filename, ...(typeof row.previous_filename === "string" ? [row.previous_filename] : [])].map(filename => ({ filename }));
    });
  } else {
    // 固定提交的完整树才能证明范围；树被截断时仍拒绝发布。
    const identities = await Promise.all([treeIdentity(read, previous), treeIdentity(read, next)]);
    const [before, after] = await Promise.all(identities.map(sha => treeFiles(read, sha)));
    files = [...new Set([...before!.keys(), ...after!.keys()])].sort()
      .filter(path => before!.get(path) !== after!.get(path)).map(filename => ({ filename }));
  }
  return { status: String(compare.status), total_commits: Number(compare.total_commits), files };
}
