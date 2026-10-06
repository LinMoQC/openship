import type { ReleasePlan, ReleaseRun, ReleaseState, ReleasePlanInput } from "@repo/contracts";
import { api } from "./client";
const project = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const releasesApi = {
  state: (id: string, fresh = false) => api.get<{ data: ReleaseState }>(`${project(id)}/release-state${fresh ? "?fresh=true" : ""}`),
  plan: (id: string, input: ReleasePlanInput = {}) => api.post<{ data: ReleasePlan }>(`${project(id)}/release-plans`, input),
  getPlan: (id: string) => api.get<{ data: ReleasePlan }>(`/release-plans/${encodeURIComponent(id)}`),
  latest: (id: string) => api.get<{ data: ReleaseRun | null }>(`${project(id)}/release-run`),
  run: (id: string) => api.get<{ data: ReleaseRun }>(`/release-runs/${encodeURIComponent(id)}`),
  start: (id: string, idempotencyKey: string, confirm?: "production") => api.post<{ data: ReleaseRun }>(`/release-plans/${encodeURIComponent(id)}/runs`, { idempotencyKey, ...(confirm && { confirm }) }),
};
