import type Dockerode from "dockerode";

/** Keep this guard at the Docker create seam as well as the Compose planner.
 * Direct callers must not turn a stateless candidate into a second database or
 * a process sharing the incumbent's host resources. */
export function assertStatelessPreflight(payload: Dockerode.ContainerCreateOptions): void {
  const host = payload.HostConfig;
  if (Object.keys(payload.Volumes ?? {}).length || host?.Binds?.length || host?.Mounts?.length || host?.VolumesFrom?.length)
    throw new Error("Health preflight refuses mounted or declared workload volumes");
  if ([host?.NetworkMode, host?.PidMode, host?.IpcMode].some(mode => mode === "host" || mode?.startsWith("container:")) || host?.Privileged || host?.Devices?.length)
    throw new Error("Health preflight refuses shared host resources or container namespaces");
}
