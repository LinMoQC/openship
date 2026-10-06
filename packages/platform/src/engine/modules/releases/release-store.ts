import { generateId, AppError } from "@repo/core";
import { repos } from "@repo/db";
import { parseInput, ReleaseBindingInputSchema, type ReleaseBinding, type ReleasePlan, type ReleaseRun, type ReleaseState } from "@repo/contracts";
import type { ReleaseStore } from "../../../releases";
const json = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v));
function binding(row: NonNullable<Awaited<ReturnType<typeof repos.releases.binding>>>): ReleaseBinding {
  return { ...parseInput(ReleaseBindingInputSchema, row.config), id: row.id, projectId: row.projectId, organizationId: row.organizationId, revision: row.revision };
}
function plan(row: NonNullable<Awaited<ReturnType<typeof repos.releases.plan>>>): ReleasePlan {
  const snapshot = row.snapshot as Pick<ReleasePlan, "current" | "target" | "checks">;
  return { ...snapshot, id: row.id, projectId: row.projectId, organizationId: row.organizationId, bindingRevision: row.bindingRevision, summaryHash: row.summaryHash, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), consumedAt: row.consumedAt?.toISOString() ?? null };
}
function run(row: NonNullable<Awaited<ReturnType<typeof repos.releases.run>>>): ReleaseRun {
  return { ...row, origin: row.origin as ReleaseRun["origin"], stage: row.stage as ReleaseRun["stage"], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export const releaseStore: ReleaseStore = {
  async binding(id) { const row = await repos.releases.binding(id); return row ? binding(row) : null; },
  async bind(ctx, projectId, input) { return binding(await repos.releases.bind({ id: generateId("rlb"), projectId, organizationId: ctx.organizationId, config: json(input) })); },
  async cache(id) { const row = await repos.releases.binding(id); if (!row?.lastState) return null; const state = row.lastState as unknown as ReleaseState; return { ...state, stale: !row.checkedAt }; },
  saveState: state => repos.releases.cache(state.binding.projectId, json(state), new Date(state.checkedAt), state.binding.revision),
  async plan(id) { const row = await repos.releases.plan(id); return row ? plan(row) : null; },
  async createPlan(p) { await repos.releases.createPlan({ id: p.id, projectId: p.projectId, organizationId: p.organizationId, bindingRevision: p.bindingRevision, snapshot: json({ current: p.current, target: p.target, checks: p.checks }), summaryHash: p.summaryHash, expiresAt: new Date(p.expiresAt), createdAt: new Date(p.createdAt) }); },
  async latest(id) { const row = await repos.releases.latest(id); return row ? run(row) : null; },
  async run(id) { const row = await repos.releases.run(id); return row ? run(row) : null; },
  async byKey(id, key) { const row = await repos.releases.runByKey(id, key); return row ? run(row) : null; },
  async active(id) { const row = await repos.releases.active(id); return row ? run(row) : null; },
  async reserve(r, now) {
    try { const result = await repos.releases.reserve({ ...r, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) }, now); return { run: run(result.row), created: result.created }; }
    catch (error) {
      const duplicate = await repos.releases.runByKey(r.projectId, r.idempotencyKey);
      if (duplicate && duplicate.planId === r.planId && duplicate.userId === r.userId) return { run: run(duplicate), created: false };
      const code = error instanceof Error && /^RELEASE_[A-Z_]+$/.test(error.message) ? error.message : "RELEASE_IN_PROGRESS";
      throw new AppError("Another release consumed this plan or is already executing", 409, code);
    }
  },
  async updateRun(id, patch, expected) { const { createdAt, updatedAt, ...values } = patch; const row = await repos.releases.updateRun(id, values, expected); return row ? run(row) : null; },
  invalidate: id => repos.releases.invalidate(id),
};
