import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "@repo/core";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";

/** A rejected version precondition is safe to retry after re-reading the same
 * object and rechecking ownership/operation fences. Transport errors are not. */
export async function deleteKubernetesObject(
  api: KubernetesApi,
  path: string,
  expectedUid: string | undefined,
  validate: (current: KubernetesObject) => void | Promise<void>,
  options: { signal?: AbortSignal; propagationPolicy?: "Foreground" } = {},
): Promise<void> {
  if (!expectedUid)
    throw new AppError(
      "The Kubernetes resource identity is missing.",
      409,
      "CLUSTER_RESOURCE_CHANGED",
    );
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let current: KubernetesObject;
    try {
      current = await api.request("GET", path, undefined, options.signal);
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return;
      throw error;
    }
    if (current.metadata.uid !== expectedUid || !current.metadata.resourceVersion)
      throw new AppError(
        "The Kubernetes resource was replaced during removal.",
        409,
        "CLUSTER_RESOURCE_CHANGED",
      );
    await validate(current);
    if (current.metadata.deletionTimestamp) return;
    try {
      await api.request(
        "DELETE",
        path,
        {
          ...(options.propagationPolicy ? { propagationPolicy: options.propagationPolicy } : {}),
          preconditions: { uid: expectedUid, resourceVersion: current.metadata.resourceVersion },
        },
        options.signal,
      );
      return;
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return;
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409 || attempt >= 4)
        throw error;
      await delay(25 * (attempt + 1), undefined, { signal: options.signal });
    }
  }
}

/** Re-read after an explicit resource-version conflict or refused admission connection. Never replay a mutation
 * after an ambiguous transport failure, or touch a replacement object. Callers
 * check ownership and their operation fence on every attempt. */
export async function patchKubernetesObject(
  api: KubernetesApi,
  path: string,
  update: (current: KubernetesObject) => Record<string, unknown> | Promise<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<KubernetesObject> {
  let uid: string | undefined;
  let conflicts = 0;
  let admissionDeadline: number | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const current = await api.request("GET", path, undefined, signal);
    if (
      !current.metadata.uid ||
      !current.metadata.resourceVersion ||
      current.metadata.deletionTimestamp
    )
      throw new AppError(
        "The Kubernetes resource is unavailable or being deleted.",
        409,
        "CLUSTER_RESOURCE_CHANGED",
      );
    if (uid && current.metadata.uid !== uid)
      throw new AppError(
        "The Kubernetes resource was replaced while applying the change.",
        409,
        "CLUSTER_RESOURCE_CHANGED",
      );
    uid = current.metadata.uid;
    const patch = await update(current);
    try {
      return await api.request(
        "PATCH",
        path,
        {
          ...patch,
          metadata: {
            ...(patch.metadata as Record<string, unknown> | undefined),
            uid,
            resourceVersion: current.metadata.resourceVersion,
          },
        },
        signal,
      );
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 409 && conflicts++ < 4) {
        await delay(25 * conflicts, undefined, { signal });
        continue;
      }
      // Kubernetes explicitly rejected this request before admission: the
      // webhook connection was refused, so the resource was not mutated.
      // Manager readiness can precede its admission listener during startup.
      // Re-read UID/resourceVersion and re-run the caller's fence on retry.
      // Other 5xx responses and ambiguous transport failures remain fatal.
      if (error instanceof KubernetesApiError && error.statusCode === 500 &&
          /failed calling webhook "[^"]+": failed to call webhook:/.test(error.message) &&
          /connect: connection refused/.test(error.message)) {
        admissionDeadline ??= Date.now() + 60_000;
        if (Date.now() < admissionDeadline) {
          await delay(2_000, undefined, { signal });
          continue;
        }
      }
      throw error;
    }
  }
}
