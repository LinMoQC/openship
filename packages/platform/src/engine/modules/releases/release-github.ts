import { AppError } from "@repo/core";
import type { ReleaseBinding, ReleasePlan, ReleaseRun } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import type { WorkflowIdentity } from "../../../releases";
import { getUserToken, githubFetch } from "../github/github.auth";
import { githubReleaseError } from "../../../release-diagnostics";
export async function githubRead<T>(ctx: ExecutionContext, b: ReleaseBinding, path: string): Promise<T> {
  const [owner, repo] = b.repository.split("/");
  try { return await githubFetch<T>({ ctx, owner, repo, allowAnonymous: false, url: `https://api.github.com/repos/${b.repository}/${path}` }); }
  catch (error) { throw githubReleaseError(error); }
}
export async function githubFile(ctx: ExecutionContext, b: ReleaseBinding, path: string, ref: string): Promise<string> {
  const file = await githubRead<{ content?: string; encoding?: string }>(ctx, b, `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
  if (file.encoding !== "base64" || typeof file.content !== "string") throw new AppError("GitOps file is unavailable or too large", 409, "RELEASE_SOURCE_UNAVAILABLE");
  return Buffer.from(file.content, "base64").toString("utf8");
}
async function userRequest(ctx: ExecutionContext, path: string, init?: RequestInit) {
  const token = await getUserToken(ctx.userId);
  if (!token) throw new AppError("Reconnect your GitHub account", 403, "GITHUB_USER_CONNECTION_REQUIRED");
  const response = await fetch(`https://api.github.com/${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000), headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" } });
  if (!response.ok) throw new AppError(`GitHub refused the operation (${response.status}). Check your connection and repository permissions.`, response.status, "GITHUB_USER_PERMISSION_REQUIRED");
  return response;
}
export async function releaseGithubActor(ctx: ExecutionContext, b: ReleaseBinding): Promise<string> {
  const actor = await (await userRequest(ctx, "user")).json() as { login?: string };
  if (!actor.login) throw new AppError("GitHub identity is unavailable", 403, "GITHUB_USER_CONNECTION_REQUIRED");
  const access = await (await userRequest(ctx, `repos/${b.repository}/collaborators/${encodeURIComponent(actor.login)}/permission`)).json() as { permission?: string };
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
  await userRequest(ctx, `repos/${b.repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { method: "POST", body: JSON.stringify({ ref: b.workflowRef, inputs }) });
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
