import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { resolveReleaseServiceArtifacts, type ArtifactDeployment, type ArtifactService, type ArtifactRow } from "../../../gitops-artifacts";

export async function releaseServiceArtifacts(deployment: ArtifactDeployment, services: ArtifactService[], rows: ArtifactRow[], names: string[]) {
  try {
    return await resolveReleaseServiceArtifacts(deployment, services, rows, names, {
      listByService: id => repos.serviceDeployment.listByService(id),
      deployment: id => repos.deployment.findById(id),
    });
  } catch {
    throw new AppError("Completed task runtime provenance cannot be verified", 409, "RELEASE_RUNTIME_UNKNOWN");
  }
}
