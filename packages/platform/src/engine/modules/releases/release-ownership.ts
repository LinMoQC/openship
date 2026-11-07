import { requireUnmanagedProject } from "../../../gitops-gate";
import { releaseStore } from "./release-store";

/** Refuses ordinary mutations on GitOps-managed projects. Kept free of the
 * release inspector's dependencies so every operation module can import it. */
export const requireGitopsRelease = (id: string) => requireUnmanagedProject(id, releaseStore.binding);
