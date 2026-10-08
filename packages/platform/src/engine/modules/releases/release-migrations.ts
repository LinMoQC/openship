import type { DockerRuntime } from "@repo/adapters";
import type { ReleaseBinding } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { migrationExecutionInventory } from "../../../gitops-migrations";
import { createMigrationChecksumCache } from "../../../gitops-migration-checksums";
import { githubBlob, githubRead } from "./release-github";
import { mapWithLimit } from "../../lib/map-with-limit";

const migrationChecksum = createMigrationChecksumCache();
export async function inspectMigrationExecution(ctx: ExecutionContext, binding: ReleaseBinding, repository: string, gitSha: string, runtime: DockerRuntime, databaseContainerId: string) {
  const source = { ...binding, repository };
  const tree = await githubRead<{ truncated: boolean; tree: Array<{ path: string; sha: string; type: string }> }>(ctx, source, `git/trees/${gitSha}?recursive=1`);
  if (tree.truncated) throw new Error("Target source tree is truncated");
  const migrations = await mapWithLimit(tree.tree.filter(file => file.type === "blob" && /^packages\/db\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(file.path)), 8, async file => ({
    name: file.path.split("/")[4]!, blobSha: file.sha,
    checksum: await migrationChecksum(repository, file.sha, () => githubRead<{ content: string; encoding: string }>(ctx, source, `git/blobs/${file.sha}`)),
  }));
  if (!migrations.length) throw new Error("Target migration inventory is missing");
  const policyBlob = tree.tree.find(file => file.type === "blob" && file.path === "packages/db/runtime/migration-compatibility-policy.json");
  const policy = policyBlob ? JSON.parse(await githubBlob(ctx, source, policyBlob.sha)) : null;
  if (policyBlob && (policy === null || typeof policy !== "object" || Array.isArray(policy))) throw new Error("Target migration policy is malformed");
  return migrationExecutionInventory(migrations, await runtime.inspectPrismaMigrations(databaseContainerId), policy);
}
