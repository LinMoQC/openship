import { Type, type TSchema } from "@sinclair/typebox";
import {
  parseInput, ReleaseStateSchema, ReleaseBindingSchema, ReleasePlanSchema, ReleaseRunSchema, ReleaseCapabilitiesSchema, ReleaseBindingInputSchema, ReleasePlanInputSchema, ReleaseRunInputSchema, ResourceIdSchema,
  type ReleaseOperations, type ReleaseState, type ReleaseBinding, type ReleasePlan, type ReleaseRun, type ReleaseCapabilities,
} from "@repo/contracts";
import type { HttpClient } from "./http";
/** Public release surface only. Workflow registration and progress belong to authenticated controllers. */
export function createRemoteReleaseOperations(http: HttpClient): ReleaseOperations {
  const id = (value: string) => encodeURIComponent(parseInput(ResourceIdSchema, value));
  async function read<T>(path: string, schema: TSchema): Promise<T> { return parseInput(schema, (await http.request<{ data: unknown }>(path)).data) as T; }
  async function post<T>(path: string, schema: TSchema, input: unknown, method = "POST"): Promise<T> { return parseInput(schema, (await http.request<{ data: unknown }>(path, { method, body: JSON.stringify(input) })).data) as T; }
  return Object.freeze({
    state: (projectId, options) => read<ReleaseState>(`/projects/${id(projectId)}/release-state${options?.fresh ? "?fresh=true" : ""}`, ReleaseStateSchema),
    bind: (projectId, input) => post<ReleaseBinding>(`/projects/${id(projectId)}/release-binding`, ReleaseBindingSchema, parseInput(ReleaseBindingInputSchema, input), "PUT"),
    plan: (projectId, input = {}) => post<ReleasePlan>(`/projects/${id(projectId)}/release-plans`, ReleasePlanSchema, parseInput(ReleasePlanInputSchema, input)),
    getPlan: planId => read<ReleasePlan>(`/release-plans/${id(planId)}`, ReleasePlanSchema),
    start: (planId, input) => post<ReleaseRun>(`/release-plans/${id(planId)}/runs`, ReleaseRunSchema, parseInput(ReleaseRunInputSchema, input)),
    latest: projectId => read<ReleaseRun | null>(`/projects/${id(projectId)}/release-run`, Type.Union([ReleaseRunSchema, Type.Null()])),
    getRun: runId => read<ReleaseRun>(`/release-runs/${id(runId)}`, ReleaseRunSchema),
    capabilities: projectId => read<ReleaseCapabilities>(`/releases/capabilities${projectId ? `?projectId=${id(projectId)}` : ""}`, ReleaseCapabilitiesSchema),
  } satisfies ReleaseOperations);
}
