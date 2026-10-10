import { desc, and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../client";
import { releaseBinding, releasePlan, releaseRun, serviceCutoverJournal } from "../schema";
const active = ["checking", "submitted", "dispatch_unknown", "queued", "syncing", "pulling", "deploying", "health", "verifying", "recovering"];
export function createReleasesRepo(db: Database) {
  return {
    binding: (projectId: string) => db.query.releaseBinding.findFirst({ where: eq(releaseBinding.projectId, projectId) }),
    bindings: () => db.select().from(releaseBinding),
    async bind(input: typeof releaseBinding.$inferInsert) {
      return (await db.insert(releaseBinding).values({ ...input, updatedAt: new Date() }).onConflictDoUpdate({ target: releaseBinding.projectId,
        set: { config: input.config, revision: sql`${releaseBinding.revision} + 1`, lastState: null, checkedAt: null, updatedAt: new Date() },
      }).returning())[0]!;
    },
    async cache(projectId: string, state: Record<string, unknown>, checkedAt: Date, bindingRevision: number) {
      await db.update(releaseBinding).set({ lastState: state, checkedAt }).where(and(eq(releaseBinding.projectId, projectId),
        eq(releaseBinding.revision, bindingRevision), sql`${releaseBinding.updatedAt} <= ${checkedAt}`,
        sql`(${releaseBinding.checkedAt} IS NULL OR ${releaseBinding.checkedAt} <= ${checkedAt})`));
    },
    async invalidate(projectId: string) {
      // Move the freshness barrier forward even within one millisecond. An
      // inspection started before a deployment/configuration change cannot
      // repopulate the cache after it was invalidated.
      await db.update(releaseBinding).set({ checkedAt: null, updatedAt: sql`GREATEST(clock_timestamp(), ${releaseBinding.updatedAt} + interval '1 millisecond')` }).where(eq(releaseBinding.projectId, projectId));
    },
    plan: (id: string) => db.query.releasePlan.findFirst({ where: eq(releasePlan.id, id) }),
    async createPlan(input: typeof releasePlan.$inferInsert) { return (await db.insert(releasePlan).values(input).returning())[0]!; },
    latest: (projectId: string) => db.query.releaseRun.findFirst({ where: eq(releaseRun.projectId, projectId), orderBy: desc(releaseRun.createdAt) }),
    latestStarted: (projectId: string) => db.query.releaseRun.findFirst({ where: and(eq(releaseRun.projectId, projectId), isNotNull(releaseRun.deploymentId)), orderBy: desc(releaseRun.createdAt) }),
    run: (id: string) => db.query.releaseRun.findFirst({ where: eq(releaseRun.id, id) }),
    runByKey: (projectId: string, key: string) => db.query.releaseRun.findFirst({ where: and(eq(releaseRun.projectId, projectId), eq(releaseRun.idempotencyKey, key)) }),
    active: (projectId: string) => db.query.releaseRun.findFirst({ where: and(eq(releaseRun.projectId, projectId), inArray(releaseRun.stage, active)) }),
    async reserve(input: typeof releaseRun.$inferInsert, now: Date) {
      return db.transaction(async tx => {
        const [plan] = await tx.select().from(releasePlan).where(eq(releasePlan.id, input.planId)).for("update");
        if (!plan || plan.projectId !== input.projectId) throw new Error("RELEASE_PLAN_NOT_FOUND");
        const existing = await tx.query.releaseRun.findFirst({ where: and(eq(releaseRun.projectId, input.projectId), eq(releaseRun.idempotencyKey, input.idempotencyKey)) });
        if (existing) return { row: existing, created: false };
        if (plan.consumedAt) throw new Error("RELEASE_PLAN_CONSUMED");
        if (plan.expiresAt <= now) throw new Error("RELEASE_PLAN_EXPIRED");
        const running = await tx.query.releaseRun.findFirst({ where: and(eq(releaseRun.projectId, input.projectId), inArray(releaseRun.stage, active)) });
        if (running) throw new Error("RELEASE_IN_PROGRESS");
        const [row] = await tx.insert(releaseRun).values(input).returning();
        await tx.update(releasePlan).set({ consumedAt: now }).where(eq(releasePlan.id, plan.id));
        return { row: row!, created: true };
      });
    },
    async updateRun(id: string, patch: Partial<typeof releaseRun.$inferInsert>, expectedStage?: string) {
      return (await db.update(releaseRun).set({ ...patch, updatedAt: new Date() }).where(and(eq(releaseRun.id, id), expectedStage ? eq(releaseRun.stage, expectedStage) : undefined)).returning())[0];
    },
    async journal(input: typeof serviceCutoverJournal.$inferInsert) {
      return (await db.insert(serviceCutoverJournal).values(input).onConflictDoUpdate({ target: [serviceCutoverJournal.deploymentId, serviceCutoverJournal.serviceName],
        set: { stage: input.stage, imageId: input.imageId, incumbentId: input.incumbentId, candidateId: input.candidateId, context: input.context, error: input.error, updatedAt: new Date() },
        setWhere: eq(serviceCutoverJournal.id, input.id),
      }).returning())[0]!;
    },
    journals: (projectId: string) => db.select().from(serviceCutoverJournal).where(eq(serviceCutoverJournal.projectId, projectId)),
    pendingJournals: () => db.select().from(serviceCutoverJournal).where(sql`${serviceCutoverJournal.stage} NOT IN ('committed','restored')`),
  };
}
