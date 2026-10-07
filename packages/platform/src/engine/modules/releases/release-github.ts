import { AppError } from "@repo/core";
import type { ReleaseBinding, ReleasePlan, ReleaseRun } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import type { WorkflowIdentity } from "../../../releases";
import { getUserToken, githubFetch } from "../github/github.auth";
import { githubReleaseError } from "../../../release-diagnostics";
import { ghFetch } from "../github/github.http";
import { createHash } from "node:crypto";

const immutableReads = new Map<string, { value: unknown; expiresAt: number; bytes: number }>();
const pendingReads = new Map<string, Promise<unknown>>();
let cachedBytes = 0;
function dropRead(key: string) { const row = immutableReads.get(key); if (row) cachedBytes -= row.bytes; immutableReads.delete(key); }
function blobBytes(value: unknown, sha: string): Buffer {
  const file = value as { sha?: string; encoding?: string; content?: string } | null;
  if (!file || file.sha !== sha || file.encoding !== "base64" || typeof file.content !== "string") throw new AppError("Frozen Git blob is unavailable", 409, "RELEASE_SOURCE_UNAVAILABLE");
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length > 2 * 1024 * 1024 || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== sha) throw new AppError("Frozen Git blob identity does not match", 409, "RELEASE_SOURCE_UNAVAILABLE");
  return bytes;
}
export async function githubRead<T>(ctx: ExecutionContext, b: ReleaseBinding, path: string): Promise<T> {
  const [owner, repo] = b.repository.split("/");
  const blob = /^git\/blobs\/([a-f0-9]{40})$/.exec(path);
  const ref = new URL(`https://api.github.com/${path}`).searchParams.get("ref");
  const immutable = !!blob || (path.startsWith("contents/") && /^[a-f0-9]{40}$/.test(ref ?? ""));
  // Ref heads are always read live. Only immutable Git identities may reuse content.
  const key = JSON.stringify([ctx.organizationId, ctx.userId, ctx.source, ctx.tokenScope?.tokenId, b.repository, path]);
  const load = async () => {
    try {
      const value = await githubFetch<T>({ ctx, owner, repo, allowAnonymous: false, url: `https://api.github.com/repos/${b.repository}/${path}` });
      if (blob) blobBytes(value, blob[1]!);
      return value;
    } catch (error) { if (error instanceof AppError && error.code === "RELEASE_SOURCE_UNAVAILABLE") throw error; throw githubReleaseError(error); }
  };
  if (!immutable) return load();
  const cached = immutableReads.get(key);
  if (cached && cached.expiresAt > Date.now()) { immutableReads.delete(key); immutableReads.set(key, cached); return structuredClone(cached.value) as T; }
  if (cached) dropRead(key);
  let pending = pendingReads.get(key);
  if (!pending) {
    pending = load().then(value => {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes <= 16 * 1024 * 1024) {
        for (const [k, row] of immutableReads) if (row.expiresAt <= Date.now()) dropRead(k);
        while (immutableReads.size >= 2000 || cachedBytes + bytes > 16 * 1024 * 1024) dropRead(immutableReads.keys().next().value!);
        immutableReads.set(key, { value: structuredClone(value), expiresAt: Date.now() + 30 * 60_000, bytes }); cachedBytes += bytes;
      }
      return value;
    });
    pendingReads.set(key, pending);
    pending.finally(() => { if (pendingReads.get(key) === pending) pendingReads.delete(key); }).catch(() => {});
  }
  return structuredClone(await pending) as T;
}
export async function githubBlob(ctx: ExecutionContext, b: ReleaseBinding, sha: string): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new AppError("Frozen Git blob identity is invalid", 409, "RELEASE_SOURCE_UNAVAILABLE");
  return blobBytes(await githubRead(ctx, b, `git/blobs/${sha}`), sha).toString("utf8");
}
export async function githubFile(ctx: ExecutionContext, b: ReleaseBinding, path: string, ref: string): Promise<string> {
  const file = await githubRead<{ content?: string; encoding?: string }>(ctx, b, `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
  if (file.encoding !== "base64" || typeof file.content !== "string") throw new AppError("GitOps file is unavailable or too large", 409, "RELEASE_SOURCE_UNAVAILABLE");
  return Buffer.from(file.content, "base64").toString("utf8");
}
async function userRequest<T = unknown>(ctx: ExecutionContext, path: string, method = "GET", params?: Record<string, unknown>): Promise<T> {
  const token = await getUserToken(ctx.userId);
  if (!token) throw new AppError("Reconnect your GitHub account", 403, "GITHUB_USER_CONNECTION_REQUIRED");
  try {
    return await ghFetch<T>(token, { url: `https://api.github.com/${path}`, method, params, redirect: "error", headers: { "Content-Type": "application/json" } });
  } catch (error) { throw githubReleaseError(error); }
}
export async function releaseGithubActor(ctx: ExecutionContext, b: ReleaseBinding): Promise<string> {
  const actor = await userRequest<{ login?: string }>(ctx, "user");
  if (!actor.login) throw new AppError("GitHub identity is unavailable", 403, "GITHUB_USER_CONNECTION_REQUIRED");
  const access = await userRequest<{ permission?: string }>(ctx, `repos/${b.repository}/collaborators/${encodeURIComponent(actor.login)}/permission`);
  if (!["admin", "maintain", "write"].includes(access.permission ?? "")) throw new AppError("Repository write permission is required", 403, "GITHUB_USER_PERMISSION_REQUIRED");
  if (b.environment === "production") {
    const policy = JSON.parse(await githubFile(ctx, b, "config/production-operators.json", "main")) as { mode?: string; operators?: string[] };
    if (policy.mode !== "manual-dispatch" || !policy.operators?.includes(actor.login)) throw new AppError("Your GitHub identity is not an authorized production operator", 403, "PRODUCTION_OPERATOR_REQUIRED");
  }
  return actor.login;
}
export async function dispatchRelease(ctx: ExecutionContext, b: ReleaseBinding, plan: ReleasePlan, run: ReleaseRun) {
  const workflow = plan.target.action === "rollback" ? b.workflows.rollback : b.environment === "preview" ? b.workflows.preview : b.workflows.production;
  const inputs = plan.target.action === "rollback"
    ? { release_run_id: run.id, release_plan_hash: plan.summaryHash, environment: b.environment, release_id: plan.target.releaseId, manifest_commit: plan.target.manifestCommit, stack: b.stack, ...(b.environment === "production" ? { confirm_production: "production" } : {}) }
    : b.environment === "preview"
    ? { release_run_id: run.id, release_plan_hash: plan.summaryHash, event_key: plan.target.eventKey ?? "", verify_only: plan.target.action === "verify", manifest_commit: plan.target.manifestCommit, stack: b.stack }
    : { release_run_id: run.id, release_plan_hash: plan.summaryHash, manifest_commit: plan.target.manifestCommit, stack: b.stack, confirm_production: "production" };
  await userRequest(ctx, `repos/${b.repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, "POST", { ref: b.workflowRef, inputs });
}
interface GithubRun { id: number; repository: { full_name: string }; path: string; head_branch: string; head_sha: string; actor: { login: string }; triggering_actor?: { login: string }; event: string; display_title: string; html_url: string; status: string; conclusion: string | null; }
function workflow(row: GithubRun): WorkflowIdentity {
  return { id: String(row.id), repository: row.repository.full_name, workflow: row.path.split("/").pop()!.split("@")[0]!, headBranch: row.head_branch, headSha: row.head_sha, actor: row.actor.login, triggeringActor: row.triggering_actor?.login ?? row.actor.login, event: row.event, title: row.display_title, url: row.html_url, status: row.status, conclusion: row.conclusion };
}
export async function releaseWorkflow(ctx: ExecutionContext, b: ReleaseBinding, id: string) { return workflow(await githubRead<GithubRun>(ctx, b, `actions/runs/${id}`)); }
export async function reconcileRelease(ctx: ExecutionContext, b: ReleaseBinding, run: ReleaseRun, plan: ReleasePlan) {
  const file = plan.target.action === "rollback" ? b.workflows.rollback : b.environment === "preview" ? b.workflows.preview : b.workflows.production;
  const found: GithubRun[] = [];
  // A busy repository can exceed one page while dispatch is being confirmed.
  // Exhaust the bounded query before claiming that no matching workflow exists.
  for (let page = 1; page <= 10; page++) {
    const rows = await githubRead<{ workflow_runs: GithubRun[] }>(ctx, b, `actions/workflows/${encodeURIComponent(file)}/runs?event=workflow_dispatch&per_page=100&page=${page}&created=${encodeURIComponent(`>=${run.createdAt}`)}`);
    found.push(...rows.workflow_runs.filter(row => row.display_title === `GitOps release ${run.id}`));
    if (rows.workflow_runs.length < 100) break;
    if (page === 10) throw new AppError("Workflow lookup is incomplete. Submission remains pending confirmation.", 503, "RELEASE_RECONCILIATION_PENDING");
  }
  if (found.length > 1) throw new AppError("Multiple workflows claim the same release run", 409, "RELEASE_WORKFLOW_CONFLICT");
  return found[0] ? workflow(found[0]) : null;
}
