import { Type, type Static } from "@sinclair/typebox";

const sha = Type.String({ pattern: "^[a-f0-9]{40}$" });
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const id = Type.String({ minLength: 1, maxLength: 200 });
const services = Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true });
export const ReleaseBindingInputSchema = Type.Object({
  environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]),
  stack: Type.String({ pattern: "^[a-z0-9-]+$" }),
  repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
  manifestPath: Type.String({ pattern: "^stacks/[a-z0-9-]+/release\\.yaml$" }),
  targetBranch: Type.String({ pattern: "^deploy/(prt|prod)$" }),
  workflowRef: Type.Literal("main"),
  workflows: Type.Object({ preview: id, production: id, rollback: id }),
  controllerTokenIds: Type.Array(id, { minItems: 1, uniqueItems: true }),
  expectedServices: services,
  probes: Type.Array(Type.String({ pattern: "^https?://[^\\s]+$" }), { minItems: 1 }),
}, { additionalProperties: false });
export type ReleaseBindingInput = Static<typeof ReleaseBindingInputSchema>;
export interface ReleaseBinding extends ReleaseBindingInput {
  id: string; projectId: string; organizationId: string; revision: number;
}
export interface ReleaseImage { image: string; digest: string; gitSha: string | null; }
export interface ReleaseTarget {
  action: "release" | "rollback" | "verify";
  workflowSha: string; manifestCommit: string; manifestHash: string; configurationHash: string;
  releaseId: string; images: Record<string, ReleaseImage>; ossGitSha: string | null;
  services: string[]; eventKey: string | null; acceptedReceipt: Record<string, unknown> | null;
  manifest: Record<string, unknown>;
}
export interface ReleaseCheck {
  key: string; label: string; status: "pass" | "fail" | "unknown"; blocking: boolean; detail: string;
}
export interface ReleaseObservation {
  deploymentId: string | null; images: Record<string, ReleaseImage>;
  configurationHash: string | null; serverEnvironmentHash?: string | null; ossGitSha: string | null; verified: boolean;
}
export type ReleaseStateKind = "current" | "available" | "configuration" | "drift" | "unknown" | "blocked";
export interface ReleaseState {
  binding: ReleaseBinding; kind: ReleaseStateKind; current: ReleaseObservation;
  target: ReleaseTarget | null; checks: ReleaseCheck[]; checkedAt: string;
  stale: boolean; error: string | null;
}
export interface ReleasePlan {
  id: string; projectId: string; organizationId: string; bindingRevision: number;
  current: ReleaseObservation; target: ReleaseTarget; checks: ReleaseCheck[];
  summaryHash: string; createdAt: string; expiresAt: string; consumedAt: string | null;
}
export const RELEASE_ACTIVE_STAGES = ["checking", "submitted", "dispatch_unknown", "queued", "syncing", "pulling", "deploying", "health", "verifying", "recovering"] as const;
export type ReleaseStage = typeof RELEASE_ACTIVE_STAGES[number] | "accepted" | "failed" | "restored" | "action_required";
export interface ReleaseRun {
  id: string; projectId: string; organizationId: string; planId: string;
  origin: "user" | "automatic"; userId: string; githubActor: string; idempotencyKey: string; stage: ReleaseStage;
  workflowRunId: string | null; workflowUrl: string | null; deploymentId: string | null;
  receipt: Record<string, unknown> | null; error: string | null; createdAt: string; updatedAt: string;
}
export const ReleasePlanInputSchema = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("release"), Type.Literal("rollback"), Type.Literal("verify")])),
  eventKey: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  manifestCommit: Type.Optional(sha),
}, { additionalProperties: false });
export type ReleasePlanInput = Static<typeof ReleasePlanInputSchema>;
export const ReleaseRunInputSchema = Type.Object({
  idempotencyKey: Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
  confirm: Type.Optional(Type.Literal("production")),
}, { additionalProperties: false });
export type ReleaseRunInput = Static<typeof ReleaseRunInputSchema>;
export const RegisterWorkflowSchema = Type.Object({ workflowRunId: Type.String({ pattern: "^[0-9]+$" }) }, { additionalProperties: false });
export const AutomaticReleaseSchema = Type.Object({
  workflowRunId: Type.String({ pattern: "^[0-9]+$" }),
  eventKey: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  manifestCommit: sha,
}, { additionalProperties: false });
export const ReleaseProgressSchema = Type.Object({
  stage: Type.Union([Type.Literal("queued"), Type.Literal("syncing"), Type.Literal("pulling"), Type.Literal("deploying"), Type.Literal("health"), Type.Literal("verifying"), Type.Literal("accepted"), Type.Literal("failed"), Type.Literal("recovering"), Type.Literal("restored"), Type.Literal("action_required")]),
  deploymentId: Type.Optional(id),
  receipt: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  error: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });
export type ReleaseProgress = Static<typeof ReleaseProgressSchema>;
export interface ReleaseCapabilities {
  runtimeVersion: string; contractVersion: 1; upstreamCommit: string;
  gitops: true; serverEnvironment: true; strictServiceScope: true; durableCutover: boolean;
}
export interface ReleaseOperations {
  state(projectId: string, options?: { fresh?: boolean }): Promise<ReleaseState>;
  bind(projectId: string, input: ReleaseBindingInput): Promise<ReleaseBinding>;
  plan(projectId: string, input?: ReleasePlanInput): Promise<ReleasePlan>;
  getPlan(id: string): Promise<ReleasePlan>;
  start(id: string, input: ReleaseRunInput): Promise<ReleaseRun>;
  latest(projectId: string): Promise<ReleaseRun | null>;
  getRun(id: string): Promise<ReleaseRun>;
  capabilities(projectId?: string): Promise<ReleaseCapabilities>;
}
// Schemas are exported for HTTP, SDK and MCP discovery. Controller routes are intentionally excluded.
export const ReleaseImageSchema = Type.Object({ image: id, digest, gitSha: Type.Union([sha, Type.Null()]) });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const nullableId = Type.Union([id, Type.Null()]);
const nullableHash = Type.Union([hash, Type.Null()]);
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
export const ReleaseBindingSchema = Type.Object({ ...ReleaseBindingInputSchema.properties, id, projectId: id, organizationId: id, revision: Type.Integer({ minimum: 1 }) });
export const ReleaseObservationSchema = Type.Object({ deploymentId: nullableId, images: Type.Record(Type.String(), ReleaseImageSchema), configurationHash: nullableHash, serverEnvironmentHash: Type.Optional(nullableHash), ossGitSha: Type.Union([sha, Type.Null()]), verified: Type.Boolean() });
export const ReleaseCheckSchema = Type.Object({ key: id, label: id, status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]), blocking: Type.Boolean(), detail: Type.String() });
export const ReleaseTargetSchema = Type.Object({
  action: Type.Union([Type.Literal("release"), Type.Literal("rollback"), Type.Literal("verify")]), workflowSha: sha, manifestCommit: sha, manifestHash: hash, configurationHash: hash,
  releaseId: id, images: Type.Record(Type.String(), ReleaseImageSchema), ossGitSha: Type.Union([sha, Type.Null()]), services: Type.Array(id, { uniqueItems: true }),
  eventKey: nullableHash, acceptedReceipt: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]), manifest: Type.Record(Type.String(), Type.Unknown()),
});
export const ReleaseStateSchema = Type.Object({ binding: ReleaseBindingSchema, kind: Type.Union([Type.Literal("current"), Type.Literal("available"), Type.Literal("configuration"), Type.Literal("drift"), Type.Literal("unknown"), Type.Literal("blocked")]), current: ReleaseObservationSchema, target: Type.Union([ReleaseTargetSchema, Type.Null()]), checks: Type.Array(ReleaseCheckSchema), checkedAt: date, stale: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]) });
/** Cached, non-sensitive card metadata. It contains no controller identity,
 * raw manifest, environment values or workflow credential. */
export const ReleaseOverviewSchema = Type.Object({
  kind: ReleaseStateSchema.properties.kind, current: ReleaseObservationSchema,
  target: Type.Union([Type.Object({ images: Type.Record(Type.String(), ReleaseImageSchema), ossGitSha: Type.Union([sha, Type.Null()]) }), Type.Null()]),
  checkedAt: Type.Union([date, Type.Null()]), stale: Type.Boolean(),
});
export type ReleaseOverview = Static<typeof ReleaseOverviewSchema>;
export const ReleasePlanSchema = Type.Object({ id, projectId: id, organizationId: id, bindingRevision: Type.Integer({ minimum: 1 }), current: ReleaseObservationSchema, target: ReleaseTargetSchema, checks: Type.Array(ReleaseCheckSchema), summaryHash: hash, createdAt: date, expiresAt: date, consumedAt: Type.Union([date, Type.Null()]) });
export const ReleaseRunSchema = Type.Object({
  id, projectId: id, organizationId: id, planId: id, origin: Type.Union([Type.Literal("user"), Type.Literal("automatic")]), userId: id, githubActor: id, idempotencyKey: id,
  stage: Type.Union([ReleaseProgressSchema.properties.stage, Type.Literal("checking"), Type.Literal("submitted"), Type.Literal("dispatch_unknown")]), workflowRunId: nullableId, workflowUrl: nullableId, deploymentId: nullableId,
  receipt: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]), error: Type.Union([Type.String(), Type.Null()]), createdAt: date, updatedAt: date,
});
export const ReleaseCapabilitiesSchema = Type.Object({ runtimeVersion: id, contractVersion: Type.Literal(1), upstreamCommit: sha, gitops: Type.Literal(true), serverEnvironment: Type.Literal(true), strictServiceScope: Type.Literal(true), durableCutover: Type.Boolean() });
