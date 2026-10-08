import { AppError } from "@repo/core";
import { repos, type Deployment } from "@repo/db";
import type { ReleaseBinding } from "@repo/contracts";
import type { DockerRuntime } from "@repo/adapters";
import type { ExecutionContext } from "../../../context";
import { checkReleaseTopology } from "../../../gitops-topology";
import { githubFile } from "./release-github";
import { parseComposeFile } from "../../lib/compose-parser";
import { decrypt } from "../../lib/encryption";
import { releaseHash } from "../../../releases";
import YAML from "yaml";
import { inspectBoundHostConfiguration } from "../../../gitops-host-configuration";
import type { ArtifactRow } from "../../../gitops-artifacts";

export async function assertReleaseHostConfiguration(ctx: ExecutionContext, binding: ReleaseBinding, runtime: DockerRuntime, configurationCommit: string) {
  const config = YAML.parse(await githubFile(ctx, binding, "platform.yaml", configurationCommit)) as { stacks?: Array<{ name: string; hostConfig?: { root: string; files: Record<string, string> } }> };
  const stack = config.stacks?.find(row => row.name === binding.stack);
  if (!stack) throw new AppError("Bound stack configuration is missing", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH");
  if (!stack.hostConfig) return;
  let hashes: Record<string, string>;
  try { hashes = await inspectBoundHostConfiguration(runtime, binding.stack, stack.hostConfig); }
  catch { throw new AppError("Host configuration scope or content cannot be verified", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH"); }
  if (releaseHash(hashes) !== releaseHash(stack.hostConfig.files)) throw new AppError("Host configuration content differs from the frozen target", 409, "RELEASE_EXECUTION_CONFIG_MISMATCH");
}

/** Reconstruct the current deployment's own document. A branch head or a new
 * target's topology must never stand in for the running ports and volumes. */
export async function releaseTopologyVerifier(ctx: ExecutionContext, binding: ReleaseBinding, deployment: Deployment, targetCompose?: ReturnType<typeof parseComposeFile>, artifacts?: ArtifactRow[]) {
  const project = await repos.project.findById(binding.projectId);
  if (!project?.composePath || !deployment.commitSha || !project.slug)
    throw new AppError("Deployed topology source is unknown", 409, "RELEASE_TOPOLOGY_UNKNOWN");
  const environment: Record<string, string> = {};
  for (const row of await repos.project.listEnvVars(project.id, binding.environment, null)) environment[row.key] = decrypt(row.value);
  const compose = targetCompose ?? parseComposeFile(await githubFile(ctx, binding, project.composePath, deployment.commitSha), { env: environment });
  if (compose.missingRequired.length) throw new AppError("Deployed topology variables are missing", 409, "RELEASE_TOPOLOGY_UNKNOWN");
  const services = await repos.service.listByProject(project.id);
  const containers = artifacts ?? await repos.service.listByDeployment(deployment.id);
  const ids = Object.fromEntries(services.flatMap(service => {
    const row = containers.find(row => row.serviceId === service.id);
    return row?.containerId ? [[service.name, row.containerId]] : [];
  }));
  return (name: string, actual: Awaited<ReturnType<DockerRuntime["inspectReleaseContainer"]>>) => {
    const configured = compose.services.find(service => service.name === name);
    const stored = services.find(service => service.name === name);
    if (!configured || !stored) return { status: "unknown" as const, detail: "当前服务没有准确部署配置" };
    if (actual.projectId !== project.id) return { status: "fail" as const, detail: "实际容器不属于当前项目" };
    if (actual.serviceName !== name) return { status: "fail" as const, detail: "实际容器不属于当前服务" };
    return checkReleaseTopology(configured, actual, { slug: project.slug!, namespaceVolumes: stored.namespaceVolumes, containerIds: ids, allowAddedMounts: targetCompose !== undefined });
  };
}
