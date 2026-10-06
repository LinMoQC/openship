import { AppError } from "@repo/core";
import type { RollbackScope } from "./rollback/index";

/** Do not redeploy an incumbent that the failed candidate never replaced. */
export function planRejectRestore(input: {
  deploymentId: string;
  previousDeploymentId?: string;
  activeDeploymentId?: string | null;
  targetServiceIds?: string[];
  strictServiceScope?: boolean;
}): { deploymentId: string; scope?: RollbackScope } | null {
  if (!input.previousDeploymentId || input.previousDeploymentId === input.deploymentId ||
      input.previousDeploymentId === input.activeDeploymentId) return null;
  if (input.strictServiceScope === true) {
    if (!Array.isArray(input.targetServiceIds) || input.targetServiceIds.length === 0 ||
        input.targetServiceIds.some(id => typeof id !== "string" || !id.trim())) {
      throw new AppError("The rejected deployment has no valid exclusive service scope", 409, "REJECT_SCOPE_UNKNOWN");
    }
    return { deploymentId: input.previousDeploymentId, scope: {
      serviceIds: [...new Set(input.targetServiceIds)], strictServiceScope: true,
    } };
  }
  return { deploymentId: input.previousDeploymentId };
}
