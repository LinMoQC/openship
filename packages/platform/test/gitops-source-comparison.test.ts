import { describe, expect, it } from "vitest";
import { verifiedSourceComparison } from "../src/gitops-source-comparison";

const before = "a".repeat(40), after = "b".repeat(40);
const beforeTree = "c".repeat(40), afterTree = "d".repeat(40);
const blob = (path: string, sha = "e".repeat(40)) => ({ path, sha, type: "blob", mode: "100644" });
const capped = { status: "ahead", total_commits: 2, files: Array.from({ length: 300 }, (_, n) => ({ filename: `app/${n}.ts` })) };
function largeFixture() {
  return new Map<string, unknown>([
    [`compare/${before}...${after}`, structuredClone(capped)],
    [`git/commits/${before}`, { sha: before, tree: { sha: beforeTree } }],
    [`git/commits/${after}`, { sha: after, tree: { sha: afterTree } }],
    [`git/trees/${beforeTree}?recursive=1`, { sha: beforeTree, truncated: false, tree: [] }],
    [`git/trees/${afterTree}?recursive=1`, { sha: afterTree, truncated: false, tree: capped.files.map(x => blob(x.filename)) }],
  ]);
}
function reader(rows: Map<string, unknown>, paths: string[] = []) {
  return async (path: string) => {
    paths.push(path);
    if (!rows.has(path)) throw new Error("Source metadata unavailable");
    return rows.get(path);
  };
}

it("verifies a 301-file release including a migration beyond GitHub's compare limit", async () => {
  const files = Array.from({ length: 300 }, (_, n) => ({ filename: `app/${n}.ts` }));
  const rows = new Map<string, unknown>([
    [`compare/${before}...${after}`, { status: "ahead", total_commits: 2, files }],
    [`git/commits/${before}`, { sha: before, tree: { sha: beforeTree } }],
    [`git/commits/${after}`, { sha: after, tree: { sha: afterTree } }],
    [`git/trees/${beforeTree}?recursive=1`, { sha: beforeTree, truncated: false, tree: [] }],
    [`git/trees/${afterTree}?recursive=1`, { sha: afterTree, truncated: false, tree: [...files.map(x => blob(x.filename)), blob("packages/db/prisma/migrations/301_late/migration.sql")] }],
  ]);
  const result = await verifiedSourceComparison(async path => {
    if (!rows.has(path)) throw new Error(`Unexpected source read: ${path}`);
    return rows.get(path);
  }, before, after);
  expect(result.files).toHaveLength(301);
  expect(result.files).toContainEqual({ filename: "packages/db/prisma/migrations/301_late/migration.sql" });
});

describe("complete release source scope", () => {
  it("includes deletions, mode changes, symlinks and submodules while excluding unchanged blobs", async () => {
    const rows = largeFixture();
    rows.set(`git/trees/${beforeTree}?recursive=1`, { sha: beforeTree, truncated: false, tree: [blob("same.ts"), blob("removed.sql"), blob("script.sh"), { ...blob("link"), mode: "120000" }, { ...blob("vendor"), mode: "160000", type: "commit" }] });
    rows.set(`git/trees/${afterTree}?recursive=1`, { sha: afterTree, truncated: false, tree: [blob("same.ts"), { ...blob("script.sh"), mode: "100755" }, { ...blob("link", "f".repeat(40)), mode: "120000" }, { ...blob("vendor", "f".repeat(40)), mode: "160000", type: "commit" }] });
    expect((await verifiedSourceComparison(reader(rows), before, after)).files).toEqual([
      { filename: "link" }, { filename: "removed.sql" }, { filename: "script.sh" }, { filename: "vendor" },
    ]);
  });
  it("uses the complete small compare response and preserves the old path of a rename", async () => {
    const paths: string[] = [];
    const read = reader(new Map([[`compare/${before}...${after}`, { status: "ahead", total_commits: 1, files: [{ filename: "archive/migration.sql", previous_filename: "packages/db/prisma/migrations/001/migration.sql" }] }]]), paths);
    const result = await verifiedSourceComparison(read, before, after);
    expect(result.files).toEqual([{ filename: "archive/migration.sql" }, { filename: "packages/db/prisma/migrations/001/migration.sql" }]);
    expect(paths).toHaveLength(1);
  });
  it.each(["behind", "diverged"])("rejects %s ancestry before reading trees", async status => {
    const paths: string[] = [];
    await expect(verifiedSourceComparison(reader(new Map([[`compare/${before}...${after}`, { ...capped, status }]]), paths), before, after)).rejects.toMatchObject({ code: "RELEASE_SOURCE_INVALID" });
    expect(paths).toHaveLength(1);
  });
  it("retains the bounded ancestry gate", async () => {
    await expect(verifiedSourceComparison(reader(new Map([[`compare/${before}...${after}`, { ...capped, total_commits: 250 }]])), before, after)).rejects.toMatchObject({ code: "RELEASE_SOURCE_INVALID" });
  });
  it.each([beforeTree, afterTree])("rejects a truncated %s tree", async treeSha => {
    const rows = largeFixture();
    rows.set(`git/trees/${treeSha}?recursive=1`, { sha: treeSha, truncated: true, tree: [] });
    await expect(verifiedSourceComparison(reader(rows), before, after)).rejects.toMatchObject({ code: "RELEASE_SOURCE_INVALID" });
  });
  it.each([
    { sha: "f".repeat(40), truncated: false, tree: [] },
    { sha: afterTree, tree: [] },
    { sha: afterTree, truncated: false, tree: [blob("same"), blob("same")] },
    { sha: afterTree, truncated: false, tree: [blob("../unsafe")] },
    { sha: afterTree, truncated: false, tree: [blob("broken", "not-a-sha")] },
  ])("rejects incomplete or mismatched tree identity %#", async tree => {
    const rows = largeFixture(); rows.set(`git/trees/${afterTree}?recursive=1`, tree);
    await expect(verifiedSourceComparison(reader(rows), before, after)).rejects.toMatchObject({ code: "RELEASE_SOURCE_INVALID" });
  });
  it("rejects metadata for a different commit", async () => {
    const rows = largeFixture(); rows.set(`git/commits/${after}`, { sha: before, tree: { sha: afterTree } });
    await expect(verifiedSourceComparison(reader(rows), before, after)).rejects.toMatchObject({ code: "RELEASE_SOURCE_INVALID" });
  });
  it("does not interpret an unavailable tree as an empty diff", async () => {
    const rows = largeFixture(); rows.delete(`git/trees/${afterTree}?recursive=1`);
    await expect(verifiedSourceComparison(reader(rows), before, after)).rejects.toThrow("Source metadata unavailable");
  });
});
