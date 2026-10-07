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

/** Re-read after an explicit resource-version conflict. Never replay a mutation
 * after an ambiguous transport failure, or touch a replacement object. Callers
 * check ownership and their operation fence on every attempt. */
export async function patchKubernetesObject(
  api: KubernetesApi,
  path: string,
  update: (current: KubernetesObject) => Record<string, unknown> | Promise<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<KubernetesObject> {
  let uid: string | undefined;
  for (let attempt = 0; ; attempt++) {
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
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409 || attempt >= 4)
        throw error;
      await delay(25 * (attempt + 1), undefined, { signal });
    }
  }
}
