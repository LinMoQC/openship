import type { RollbackScope } from "./rollback";

export interface RejectRestoreInput {
  deploymentId: string;
  previousDeploymentId?: string;
  activeDeploymentId?: string | null;
  targetServiceIds?: string[];
  strictServiceScope?: boolean;
}

export function planRejectRestore(input: RejectRestoreInput): {
  deploymentId: string;
  scope?: RollbackScope;
} | null {
  const previous = input.previousDeploymentId;
  if (!previous || previous === input.deploymentId || previous === input.activeDeploymentId)
    return null;

  const serviceIds = [...new Set(input.targetServiceIds ?? [])];
  return {
    deploymentId: previous,
    ...(input.strictServiceScope === true && serviceIds.length > 0
      ? { scope: { serviceIds, strictServiceScope: true } }
      : {}),
  };
}
