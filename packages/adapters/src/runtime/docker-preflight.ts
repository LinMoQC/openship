import type Dockerode from "dockerode";
import { randomUUID } from "node:crypto";

export interface HealthcheckPreflight {
  timeoutMs: number;
  signal?: AbortSignal;
}

async function waitHealthy(container: Dockerode.Container, options: HealthcheckPreflight) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const state = (await container.inspect()).State;
    if (!state.Running || state.Restarting)
      throw new Error("Health preflight container exited or restarted");
    if (state.Health?.Status === "healthy") return;
    if (state.Health?.Status === "unhealthy")
      throw new Error("Health preflight container became unhealthy");
    if (!state.Health) throw new Error("Health preflight requires a Docker healthcheck");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))),
    );
  }
  throw new Error("Health preflight timed out waiting for healthy");
}

/** Explicitly opted-in, stateless Docker workloads only. The candidate has no
 * published ports or serving DNS alias. Retain the incumbent through activation
 * so a bind/start/health failure can restore the same container and configuration.
 * This does not provide crash-atomic recovery if the daemon/control plane dies. */
export async function deployPreflightedService(
  docker: Dockerode,
  payload: Dockerode.ContainerCreateOptions,
  options: HealthcheckPreflight,
  warn: (message: string) => void,
): Promise<{ container: Dockerode.Container; commit(): Promise<void>; rollback(): Promise<void> }> {
  options.signal?.throwIfAborted();
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 600_000
  ) {
    throw new Error("Health preflight timeout must be between 1 and 600000 ms");
  }
  const image = await docker.getImage(payload.Image!).inspect();
  if (Object.keys(image.Config?.Volumes ?? {}).length > 0) {
    throw new Error("Health preflight refuses image-declared volumes");
  }
  const healthcheck = payload.Healthcheck ?? image.Config?.Healthcheck;
  if (!healthcheck?.Test?.length || healthcheck.Test[0] === "NONE") {
    throw new Error("Health preflight requires an enabled Docker healthcheck");
  }
  // Pin BOTH creates to the inspected local image ID, including when a caller
  // used a mutable tag. A concurrent pull must not change the second workload.
  const activationPayload = { ...payload, Image: image.Id };
  const candidateHostname = `preflight-${randomUUID().slice(0, 8)}`;
  const candidateName = `${payload.name}-${candidateHostname}`;
  const candidate = await docker.createContainer({
    ...activationPayload,
    name: candidateName,
    Hostname: candidateHostname,
    Labels: { ...payload.Labels, "openship.service": candidateName, "openship.preflight": "true" },
    ExposedPorts: {},
    HostConfig: { ...payload.HostConfig, PortBindings: {}, RestartPolicy: { Name: "no" } },
    NetworkingConfig: {
      EndpointsConfig: Object.fromEntries(
        Object.keys(payload.NetworkingConfig?.EndpointsConfig ?? {}).map((network) => [
          network,
          { Aliases: [candidateHostname] },
        ]),
      ),
    },
  });
  try {
    await candidate.start();
    await waitHealthy(candidate, options);
  } finally {
    // Failure to clean up must veto cutover, not leave a duplicate app running.
    await candidate.remove({ force: true, v: true });
  }
  options.signal?.throwIfAborted();

  let incumbent: Dockerode.Container | undefined;
  let wasRunning = false;
  let hadHealthcheck = false;
  const existing = docker.getContainer(payload.name!);
  try {
    const info = await existing.inspect();
    if (info.Config?.Labels?.["openship.project"] !== payload.Labels?.["openship.project"]) {
      throw new Error("Health preflight refuses to replace a foreign container");
    }
    // A dockerode handle created from a NAME keeps that name as its identifier.
    // Pin the immutable ID before renaming, or restore would address the new
    // container (or a now-missing name) instead of the retained incumbent.
    incumbent = docker.getContainer(info.Id);
    wasRunning = info.State.Running;
    hadHealthcheck = !!info.State.Health;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }

  let stopped = false;
  let renamed = false;
  let replacement: Dockerode.Container | undefined;
  try {
    if (incumbent) {
      if (wasRunning) {
        await incumbent.stop();
        stopped = true;
      }
      await incumbent.rename({ name: `${payload.name}-retained-${randomUUID().slice(0, 8)}` });
      renamed = true;
    }
    options.signal?.throwIfAborted();
    replacement = await docker.createContainer(activationPayload);
    await replacement.start();
    await waitHealthy(replacement, options);
  } catch (error) {
    try {
      if (replacement) await replacement.remove({ force: true, v: true });
      if (incumbent && renamed) await incumbent.rename({ name: payload.name! });
      if (incumbent && stopped) {
        await incumbent.start();
        // Recovery is not cancelled with the failed attempt.
        if (hadHealthcheck) await waitHealthy(incumbent, { timeoutMs: options.timeoutMs });
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Service activation failed and incumbent recovery failed; manual recovery required",
      );
    }
    throw error;
  }
  let settled = false;
  return {
    container: replacement,
    async commit() {
      if (settled) return;
      settled = true;
      if (incumbent) {
        await incumbent
          .remove({ force: true })
          .catch(() =>
            warn(
              "Healthy replacement is active; retained stopped container cleanup was deferred.\n",
            ),
          );
      }
    },
    async rollback() {
      if (settled) return;
      // The outer pipeline may have cleaned up the failed replacement already.
      await replacement.remove({ force: true, v: true }).catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      });
      if (incumbent && renamed) {
        await incumbent.rename({ name: payload.name! });
        renamed = false;
      }
      if (incumbent && stopped) {
        await incumbent.start();
        stopped = false;
        if (hadHealthcheck) await waitHealthy(incumbent, { timeoutMs: options.timeoutMs });
      }
      settled = true;
    },
  };
}
