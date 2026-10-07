import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { env } from "../config/env";

import { resolvesToLocalHost } from "./self-host";

let cachedBoxOrgId: string | null = null;
let cacheGeneration = 0;

/** Drop the founding-org memo after a whole-instance restore. */
export function clearBoxOwningOrgCache(): void {
  cacheGeneration += 1;
  cachedBoxOrgId = null;
}

/**
 * The organization that OWNS this control-plane box: the founding admin's
 * personal org (`org_<founderId>`), or an explicitly pinned legacy workspace
 * that this same founder owns — the same org self-server.ts registers the
 * isLocal "This Server" row in.
 *
 * Only this org may treat a loopback/self server row as the local host, which
 * resolves to `createHostExecutor()` + the mounted docker socket — i.e. code
 * execution on the control-plane host (DooD ≈ root). Without this gate, on a
 * multi-org self-hosted box any teammate's personal org could POST a
 * `sshHost: 127.0.0.1` server and mint itself a host-root deploy target
 * (ordinary members pass the `server` resource-type permission check).
 *
 * Memoized: the founding admin is created once and never changes. Null before
 * onboarding (no admin yet) — no deploys happen then anyway.
 */
export async function boxOwningOrgId(): Promise<string | null> {
  const configured = env.OPENSHIP_HOST_ORGANIZATION_ID;
  if (cachedBoxOrgId && !configured) return cachedBoxOrgId;
  const generation = cacheGeneration;
  const admin = await repos.user.findFoundingAdmin();
  if (!admin?.id) return null;
  const resolved = configured ?? `org_${admin.id}`;
  if (configured) {
    const [organization, membership] = await Promise.all([
      repos.organization.findById(configured), repos.member.find(configured, admin.id),
    ]);
    if (!organization || membership?.role !== "owner") {
      throw new AppError("Configured host workspace must exist and be owned by the founding admin", 403, "HOST_OWNER_CONFIG_INVALID");
    }
  }
  // A legacy team's membership can change; never memoize its ownership proof.
  if (generation === cacheGeneration && !configured) cachedBoxOrgId = resolved;
  return resolved;
}

type LocalServerRow = {
  isLocal?: boolean | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshJumpHost?: string | null;
  sshTransport?: string | null;
  organizationId?: string | null;
};

/**
 * True when a `servers` row denotes THIS box and may be run on locally.
 *
 * An `isLocal` row is trusted — only the boot reconcile (founding org) or a
 * box-org-gated adopt/self-heal ever sets that flag. A row that merely
 * `resolvesToLocalHost` (loopback / SERVER_IP) is treated as local ONLY when it
 * belongs to the box-owning org, never a teammate's org.
 */
export async function isLocalHostRow(server: LocalServerRow): Promise<boolean> {
  if (server.isLocal) return true;
  if (!resolvesToLocalHost(server)) return false;
  const boxOrg = await boxOwningOrgId();
  return !!boxOrg && server.organizationId === boxOrg;
}
