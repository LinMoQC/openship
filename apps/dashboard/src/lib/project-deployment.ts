import { deployApi } from "@/lib/api/deploy";

/** Keep all project-level manual actions in the selected environment. */
export function triggerProjectDeployment(
  project: { id: string; environmentType?: "production" | "preview" | "development" },
  mode: "smart" | "all" | "refresh" = "smart",
) {
  return deployApi.trigger({
    projectId: project.id,
    environment: project.environmentType,
    ...(mode === "all"
      ? { forceAll: true }
      : mode === "refresh"
        ? { refresh: true }
        : { smartRoute: true }),
  });
}
