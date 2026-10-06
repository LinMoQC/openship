import { pgTable, text, timestamp, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { project } from "./project";
import { organization } from "./organization";
export const releaseBinding = pgTable("release_binding", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(1), config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  lastState: jsonb("last_state").$type<Record<string, unknown>>(), checkedAt: timestamp("checked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("release_binding_project").on(t.projectId)]);
export const releasePlan = pgTable("release_plan", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  bindingRevision: integer("binding_revision").notNull(), snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  summaryHash: text("summary_hash").notNull(), expiresAt: timestamp("expires_at").notNull(), consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [index("release_plan_project").on(t.projectId)]);
export const releaseRun = pgTable("release_run", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().references(() => releasePlan.id), userId: text("user_id").notNull(), githubActor: text("github_actor").notNull(),
  origin: text("origin").notNull().default("user"),
  idempotencyKey: text("idempotency_key").notNull(), stage: text("stage").notNull().default("submitted"),
  workflowRunId: text("workflow_run_id"), workflowUrl: text("workflow_url"), deploymentId: text("deployment_id"),
  receipt: jsonb("receipt").$type<Record<string, unknown>>(), error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("release_run_idempotency").on(t.projectId, t.idempotencyKey), uniqueIndex("release_run_plan").on(t.planId),
  uniqueIndex("release_run_active_project").on(t.projectId).where(sql`${t.stage} IN ('checking','submitted','dispatch_unknown','queued','syncing','pulling','deploying','health','verifying','recovering')`)]);
export const serviceCutoverJournal = pgTable("service_cutover_journal", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  deploymentId: text("deployment_id").notNull(), serviceName: text("service_name").notNull(), stage: text("stage").notNull(),
  imageId: text("image_id").notNull(), incumbentId: text("incumbent_id"), candidateId: text("candidate_id"),
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}), error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("service_cutover_identity").on(t.deploymentId, t.serviceName), index("service_cutover_pending").on(t.stage)]);
