import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { resolveObservedServiceArtifacts, resolveReleaseServiceArtifacts, type ArtifactDeployment, type ArtifactService, type ArtifactRow } from "../../../gitops-artifacts";

const reader = {
  listByService: (id: string) => repos.serviceDeployment.listByService(id),
  deployment: (id: string) => repos.deployment.findById(id),
};

export function observedServiceArtifacts(deployment: ArtifactDeployment, services: ArtifactService[], rows: ArtifactRow[], names: string[]) {
  return resolveObservedServiceArtifacts(deployment, services, rows, names, reader);
}

export async function releaseServiceArtifacts(deployment: ArtifactDeployment, services: ArtifactService[], rows: ArtifactRow[], names: string[]) {
  try {
    return await resolveReleaseServiceArtifacts(deployment, services, rows, names, reader);
  } catch {
    throw new AppError("Completed task runtime provenance cannot be verified", 409, "RELEASE_RUNTIME_UNKNOWN");
  }
}
