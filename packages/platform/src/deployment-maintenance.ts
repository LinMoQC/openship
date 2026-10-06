import { lstatSync } from "node:fs";
import { AppError } from "@repo/contracts";

/** Root-owned maintenance marker is independent of the database being migrated.
 * Missing/false client flags cannot bypass it. */
export function assertDeploymentsAvailable(): void {
  const path = process.env.OPENSHIP_DEPLOYMENT_FREEZE_FILE || "/var/lib/magic-openship-runtime/deployments-frozen";
  try { lstatSync(path); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw new AppError("Control-platform maintenance state cannot be verified", 503, "DEPLOYMENT_MAINTENANCE");
  }
  throw new AppError("The control platform is in maintenance; deployment is temporarily frozen", 503, "DEPLOYMENT_MAINTENANCE");
}
