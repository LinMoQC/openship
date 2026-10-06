import type Dockerode from "dockerode";
import { randomUUID } from "node:crypto";
import { waitForHealthyContainer, type HealthcheckPreflight } from "./docker-preflight";
import { assertStatelessPreflight } from "./docker-preflight-scope";

/** Persist only identities and recovery instructions. Never persist a create
 * payload: Env and command arguments can contain application credentials. */
export interface ServiceCutoverRecord {
  id: string;
  projectId: string;
  deploymentId: string;
  serviceName: string;
  stage: string;
  imageId: string;
  incumbentId: string | null;
  candidateId: string | null;
  context: {
    containerName: string;
    preflightName: string;
    retainedName: string;
    preflightId: string | null;
    wasRunning: boolean;
    hadHealthcheck: boolean;
    timeoutMs: number;
    releaseRunId: string;
    previousDeploymentId: string | null;
  };
  error: string | null;
}
export interface CutoverPersistence {
  releaseRunId: string;
  previousDeploymentId: string | null;
  save(record: ServiceCutoverRecord): Promise<void>;
}
const label = "openship.cutover";
const role = "openship.cutover.role";
const absent = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;

async function inspect(docker: Dockerode, id: string) {
  try { return await docker.getContainer(id).inspect(); }
  catch (error) { if (absent(error)) return null; throw error; }
}
async function owned(docker: Dockerode, record: ServiceCutoverRecord, name: string, expectedRole: string) {
  const info = await inspect(docker, name);
  if (info && (info.Config.Labels?.[label] !== record.id || info.Config.Labels?.[role] !== expectedRole || info.Config.Labels?.["openship.project"] !== record.projectId))
    throw new Error("Cutover recovery found a foreign container; manual recovery required");
  return info;
}
async function removeOwned(docker: Dockerode, record: ServiceCutoverRecord, name: string, expectedRole: string) {
  const info = await owned(docker, record, name, expectedRole);
  if (info) await docker.getContainer(info.Id).remove({ force: true });
}

/** Reconstructable after process death, including a lost create/rename response.
 * Names and ownership labels were journaled BEFORE their corresponding action. */
export async function settleServiceCutover(
  docker: Dockerode,
  record: ServiceCutoverRecord,
  decision: "commit" | "restore",
  save: CutoverPersistence["save"],
): Promise<void> {
  if (record.stage === "committed" || record.stage === "restored") return;
  const persist = async (stage: string, error: string | null = null) => {
    record.stage = stage; record.error = error; await save(record);
  };
  try {
    if (decision === "commit") {
      const current = await owned(docker, record, record.context.containerName, "replacement");
      if (!current || current.Image !== record.imageId || !current.State.Running)
        throw new Error("Cutover commit cannot verify the accepted replacement");
      await waitForHealthyContainer(docker.getContainer(current.Id), { timeoutMs: record.context.timeoutMs });
      await persist("commit_pending");
      if (record.incumbentId) {
        const old = await inspect(docker, record.incumbentId);
        if (old) {
          if (old.Config.Labels?.["openship.project"] !== record.projectId || old.State.Running || old.Name !== `/${record.context.retainedName}`)
            throw new Error("Retained container identity changed; cleanup requires manual review");
          await docker.getContainer(old.Id).remove();
        }
      }
      await removeOwned(docker, record, record.context.preflightName, "preflight");
      await persist("committed");
      return;
    }
    await persist("restoring");
    // Inspect both names first. A foreign serving container must never be removed.
    const serving = await inspect(docker, record.context.containerName);
    if (serving && serving.Id !== record.incumbentId) await owned(docker, record, serving.Id, "replacement");
    let old = record.incumbentId ? await inspect(docker, record.incumbentId) : null;
    if (record.incumbentId && (!old || old.Config.Labels?.["openship.project"] !== record.projectId || ![`/${record.context.containerName}`, `/${record.context.retainedName}`].includes(old.Name)))
      throw new Error("Retained incumbent is missing or changed; manual recovery required");
    await removeOwned(docker, record, record.context.preflightName, "preflight");
    if (serving && serving.Id !== record.incumbentId) await docker.getContainer(serving.Id).remove({ force: true });
    // A replacement may have been created by ID and renamed by another recovery.
    if (record.candidateId && record.candidateId !== serving?.Id) await removeOwned(docker, record, record.candidateId, "replacement");
    if (old) {
      const incumbent = docker.getContainer(old.Id);
      if (old.Name !== `/${record.context.containerName}`) await incumbent.rename({ name: record.context.containerName });
      if (record.context.wasRunning && !old.State.Running) await incumbent.start();
      if (record.context.wasRunning && record.context.hadHealthcheck)
        await waitForHealthyContainer(incumbent, { timeoutMs: record.context.timeoutMs });
    }
    await persist("restored");
  } catch (error) {
    // Never serialize Docker errors; they may echo the create payload or Env.
    await persist(decision === "commit" ? "commit_pending" : "recovery_failed", "Container recovery or cleanup could not be verified");
    throw error;
  }
}

export async function deployDurablePreflightedService(
  docker: Dockerode,
  payload: Dockerode.ContainerCreateOptions,
  options: HealthcheckPreflight,
  journal: CutoverPersistence,
) {
  options.signal?.throwIfAborted();
  assertStatelessPreflight(payload);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 600_000)
    throw new Error("Health preflight timeout must be between 1 and 600000 ms");
  const image = await docker.getImage(payload.Image!).inspect();
  if (Object.keys(image.Config?.Volumes ?? {}).length) throw new Error("Health preflight refuses image-declared volumes");
  const health = payload.Healthcheck ?? image.Config?.Healthcheck;
  if (!health?.Test?.length || health.Test[0] === "NONE") throw new Error("Health preflight requires an enabled Docker healthcheck");
  const existing = await inspect(docker, payload.name!);
  if (existing && existing.Config.Labels?.["openship.project"] !== payload.Labels?.["openship.project"])
    throw new Error("Health preflight refuses to replace a foreign container");
  const id = randomUUID();
  const record: ServiceCutoverRecord = {
    id, projectId: payload.Labels!["openship.project"]!, deploymentId: payload.Labels!["openship.deployment"]!,
    serviceName: payload.Labels!["openship.service"]!, stage: "prepared", imageId: image.Id,
    incumbentId: existing?.Id ?? null, candidateId: null, error: null,
    context: { containerName: payload.name!, preflightName: `${payload.name}-preflight-${id}`, retainedName: `${payload.name}-retained-${id}`,
      preflightId: null, wasRunning: existing?.State.Running ?? false, hadHealthcheck: !!existing?.State.Health,
      timeoutMs: options.timeoutMs, releaseRunId: journal.releaseRunId, previousDeploymentId: journal.previousDeploymentId },
  };
  const persist = async (stage: string) => { record.stage = stage; await journal.save(record); };
  await persist("prepared");
  const labels = { ...payload.Labels, [label]: id };
  const activation = { ...payload, Image: image.Id, Labels: { ...labels, [role]: "replacement" } };
  let replacement: Dockerode.Container;
  try {
    await persist("preflight_creating");
    const candidate = await docker.createContainer({
      ...activation, name: record.context.preflightName, Hostname: `preflight-${id}`,
      Labels: { ...labels, [role]: "preflight", "openship.preflight": "true", "openship.service": record.context.preflightName },
      ExposedPorts: {}, HostConfig: { ...payload.HostConfig, PortBindings: {}, RestartPolicy: { Name: "no" } },
      NetworkingConfig: { EndpointsConfig: Object.fromEntries(Object.keys(payload.NetworkingConfig?.EndpointsConfig ?? {}).map(network => [network, { Aliases: [`preflight-${id}`] }])) },
    });
    record.context.preflightId = candidate.id;
    await persist("preflight_starting");
    await candidate.start();
    await waitForHealthyContainer(candidate, options);
    await candidate.remove({ force: true });
    options.signal?.throwIfAborted();
    // Every intent is durable before the incumbent can stop or lose its name.
    await persist("cutover_stopping");
    if (existing) {
      const old = docker.getContainer(existing.Id);
      if (record.context.wasRunning) await old.stop();
      await persist("cutover_renaming");
      await old.rename({ name: record.context.retainedName });
    }
    options.signal?.throwIfAborted();
    await persist("replacement_creating");
    replacement = await docker.createContainer(activation);
    record.candidateId = replacement.id;
    await persist("replacement_starting");
    await replacement.start();
    await waitForHealthyContainer(replacement, options);
    await persist("awaiting_acceptance");
  } catch (error) {
    try { await settleServiceCutover(docker, record, "restore", journal.save); }
    catch (restoreError) { throw new AggregateError([error, restoreError], "Service activation and recovery failed; manual recovery required"); }
    throw error;
  }
  return { container: replacement,
    commit: () => settleServiceCutover(docker, record, "commit", journal.save),
    rollback: () => settleServiceCutover(docker, record, "restore", journal.save),
  };
}
