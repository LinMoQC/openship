import { Hono } from "hono";
import type { Context } from "hono";
import { ReleaseBindingInputSchema, ReleasePlanInputSchema, ReleaseRunInputSchema, RegisterWorkflowSchema, ReleaseProgressSchema, AutomaticReleaseSchema, ResourceIdSchema, parseInput } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { secureRouter } from "../../lib/secure-router";
import { param } from "../../lib/controller-helpers";
import { streamSSE } from "../../lib/sse";
const ops = () => getPlatformKernel().releases;
const project = secureRouter(new Hono(), { module: "releases", basePath: "/api/projects/:id" });
project.get("/release-state", { tag: "project:read", mcp: { description: "Read actual and target GitOps versions with preflight state" } }, async c => c.json({ success: true, data: await operationData(c, ops().state(operationContext(c), param(c, "id"), { fresh: c.req.query("fresh") === "true" })) }));
project.get("/release-run", { tag: "project:read", mcp: { description: "Read the latest persisted GitOps release run for this project" } }, async c => c.json({ success: true, data: await operationData(c, ops().latest(operationContext(c), param(c, "id"))) }));
project.put("/release-binding", { tag: "project:admin", auditHandledByOperation: true, body: ReleaseBindingInputSchema, mcpExcluded: "Explicit operator configuration of GitOps ownership and controller identities" }, async c => c.json({ success: true, data: await operationData(c, ops().bind(operationContext(c), param(c, "id"), await c.req.json())) }));
project.post("/release-plans", { tag: "project:write", auditHandledByOperation: true, body: ReleasePlanInputSchema, mcp: { description: "Create a frozen ten-minute GitOps release plan with read-only preflight" } }, async c => c.json({ success: true, data: await operationData(c, ops().plan(operationContext(c), param(c, "id"), await c.req.json())) }, 201));
project.post("/controller-releases", { tag: "project:write", auditHandledByOperation: true, body: AutomaticReleaseSchema, mcpExcluded: "Bound automatic PRT controller registration" }, async c => c.json({ success: true, data: await operationData(c, ops().automatic(operationContext(c), param(c, "id"), await c.req.json())) }, 201));
// Authorize through the stored project's scope, not a caller-supplied parent ID.
const plans = secureRouter(new Hono(), { module: "release-plans", basePath: "/api/release-plans" });
const dynamic = { tag: "project:read", authorizationHandledByOperation: true, mcpExcluded: "Saved release operations authorize their stored parent project" } as const;
plans.get("/:id", dynamic, async c => c.json({ success: true, data: await operationData(c, ops().getPlan(operationContext(c), param(c, "id"))) }));
plans.post("/:id/runs", { ...dynamic, tag: "project:write", body: ReleaseRunInputSchema, auditHandledByOperation: true }, async c => c.json({ success: true, data: await operationData(c, ops().start(operationContext(c), param(c, "id"), await c.req.json())) }, 202));
const runs = secureRouter(new Hono(), { module: "release-runs", basePath: "/api/release-runs" });
runs.get("/:id", dynamic, async c => c.json({ success: true, data: await operationData(c, ops().getRun(operationContext(c), param(c, "id"))) }));
runs.post("/:id/register-workflow", { ...dynamic, tag: "project:write", body: RegisterWorkflowSchema, auditHandledByOperation: true }, async c => c.json({ success: true, data: await operationData(c, ops().register(operationContext(c), param(c, "id"), await c.req.json())) }));
runs.post("/:id/progress", { ...dynamic, tag: "project:write", body: ReleaseProgressSchema, auditHandledByOperation: true }, async c => c.json({ success: true, data: await operationData(c, ops().progress(operationContext(c), param(c, "id"), await c.req.json())) }));
runs.get("/:id/events", dynamic, async (c: Context) => {
  await ops().getRun(operationContext(c), param(c, "id"));
  return streamSSE(c, async stream => {
    while (!stream.aborted) {
      const run = await operationData(c, ops().getRun(operationContext(c), param(c, "id")));
      await stream.writeSSE({ event: "release", data: JSON.stringify(run), id: run.updatedAt });
      if (["accepted", "failed", "restored", "action_required"].includes(run.stage)) break;
      await stream.sleep(2000);
    }
  });
});
const capabilities = secureRouter(new Hono(), { module: "release-capabilities", basePath: "/api/releases" });
capabilities.get("/capabilities", { tag: "updates:read", authorizationHandledByOperation: true, mcp: { description: "Read immutable runtime and GitOps contract capabilities within the optional project scope" } }, async c => {
  const projectId = c.req.query("projectId");
  return c.json({ success: true, data: await operationData(c, ops().capabilities(operationContext(c), projectId === undefined ? undefined : parseInput(ResourceIdSchema, projectId))) });
});
export const releaseProjectRoutes = project.hono, releasePlanRoutes = plans.hono, releaseRunRoutes = runs.hono, releaseCapabilityRoutes = capabilities.hono;
