import { Command } from "commander";
import { getShipClient } from "../lib/ship-client";
import { printJson, isJsonMode, info } from "../lib/output";
import type { ReleasePlanInput } from "@repo/sdk/client";
function show(value: unknown) { if (isJsonMode()) printJson(value); else info(JSON.stringify(value, null, 2)); }
export const releaseCommand = new Command("release").description("Inspect and submit frozen GitOps release plans");
releaseCommand.command("capabilities").action(async () => show(await getShipClient().releases.capabilities()));
releaseCommand.command("state").requiredOption("--project <id>", "Bound project ID").option("--fresh", "Read latest GitOps and runtime state").action(async opts => show(await getShipClient().releases.state(opts.project, { fresh: !!opts.fresh })));
releaseCommand.command("plan").requiredOption("--project <id>", "Bound project ID").option("--event-key <key>", "Exact pending release event").option("--manifest-commit <sha>", "Exact accepted production candidate or PRT base").action(async opts => {
  const input: ReleasePlanInput = { ...(opts.eventKey && { eventKey: opts.eventKey }), ...(opts.manifestCommit && { manifestCommit: opts.manifestCommit }) };
  show(await getShipClient().releases.plan(opts.project, input));
});
releaseCommand.command("show <plan-id>").action(async id => show(await getShipClient().releases.getPlan(id)));
releaseCommand.command("start <plan-id>").requiredOption("--idempotency-key <key>", "Stable key for this submission; preserve it on retry").option("--confirm <environment>", "Type production for a production plan").action(async (id, opts) => {
  if (opts.confirm !== undefined && opts.confirm !== "production") throw new Error("--confirm must be production");
  show(await getShipClient().releases.start(id, { idempotencyKey: opts.idempotencyKey, ...(opts.confirm && { confirm: "production" }) }));
});
releaseCommand.command("run <run-id>").action(async id => show(await getShipClient().releases.getRun(id)));
