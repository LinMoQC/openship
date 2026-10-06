CREATE TABLE "release_binding" (
 "id" text PRIMARY KEY, "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
 "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "revision" integer NOT NULL DEFAULT 1, "config" jsonb NOT NULL, "last_state" jsonb, "checked_at" timestamp,
 "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "release_binding_project" ON "release_binding"("project_id");
--> statement-breakpoint
CREATE TABLE "release_plan" (
 "id" text PRIMARY KEY, "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
 "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "binding_revision" integer NOT NULL, "snapshot" jsonb NOT NULL, "summary_hash" text NOT NULL,
 "expires_at" timestamp NOT NULL, "consumed_at" timestamp, "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "release_plan_project" ON "release_plan"("project_id");
--> statement-breakpoint
CREATE TABLE "release_run" (
 "id" text PRIMARY KEY, "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
 "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "plan_id" text NOT NULL REFERENCES "release_plan"("id"), "user_id" text NOT NULL, "github_actor" text NOT NULL,
 "origin" text DEFAULT 'user' NOT NULL,
  "idempotency_key" text NOT NULL, "stage" text NOT NULL DEFAULT 'submitted', "workflow_run_id" text,
 "workflow_url" text, "deployment_id" text, "receipt" jsonb, "error" text,
 "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "release_run_idempotency" ON "release_run"("project_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "release_run_plan" ON "release_run"("plan_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "release_run_active_project" ON "release_run"("project_id") WHERE "stage" IN ('checking','submitted','dispatch_unknown','queued','syncing','pulling','deploying','health','verifying','recovering');
--> statement-breakpoint
CREATE TABLE "service_cutover_journal" (
 "id" text PRIMARY KEY, "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
 "deployment_id" text NOT NULL, "service_name" text NOT NULL, "stage" text NOT NULL, "image_id" text NOT NULL,
 "incumbent_id" text, "candidate_id" text, "context" jsonb NOT NULL DEFAULT '{}', "error" text,
 "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "service_cutover_identity" ON "service_cutover_journal"("deployment_id", "service_name");
--> statement-breakpoint
CREATE INDEX "service_cutover_pending" ON "service_cutover_journal"("stage");
--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_release_run" ON "deployment" (("meta"->>'releaseRunId')) WHERE "meta"->>'releaseRunId' IS NOT NULL;
