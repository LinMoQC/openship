import YAML from "yaml";
import { createHash } from "node:crypto";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { DockerRuntime } from "@repo/adapters";
import type { ReleaseBinding, ReleaseCheck, ReleaseImage, ReleasePlanInput, ReleaseTarget, ReleaseObservation } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { manifestHash, releaseHash } from "../../../releases";
import { gitopsConfigurationHash, observedGitopsConfigurationHash, renderGitopsCompose, selectedImageExpectations } from "../../../gitops-compose";
import { productionRecoveryScope, productionReleaseScope, runtimeScopeCheck, unacceptedAttemptRecoveryScope } from "../../../gitops-release-scope";
import { githubBlob, githubFile, githubRead } from "./release-github";
import { resolveDeploymentRuntimeForRead, disposeRuntime } from "../../lib/deployment-runtime";
import { parseComposeFile, blockingComposeFields } from "../../lib/compose-parser";
import { migrationInputsChanged, migrationEvidenceMatches } from "../../../gitops-migrations";
import { observedManifestContract } from "../../../gitops-observed-manifest";
import { missingTargetTopology } from "../../../gitops-topology";
import { inspectMigrationExecution } from "./release-migrations";
import { serverEnvironmentHash } from "./release-gate";
import { releaseStore } from "./release-store";
import { decrypt } from "../../lib/encryption";
import { releaseTopologyVerifier } from "./release-topology";
import { checkReleaseEnvironment, type ReleaseEnvironmentGroup } from "../../../gitops-environment";
import { inspectBoundHostConfiguration } from "../../../gitops-host-configuration";
import { assertRetainedTaskContainer, untouchedTaskDrift } from "../../../gitops-artifacts";
import { observedServiceArtifacts } from "./release-artifacts";

interface Image { image: string; digest: string; gitSha?: string; migrationsChanged?: boolean; tag?: string; }
interface Manifest { schemaVersion: 2; stack: string; releaseId: string; services: Record<string, Image>; infrastructure?: Record<string, Image>; ossGitSha?: string; migrationEpoch?: string; [key: string]: unknown; }
interface Stack { releaseChecks?: { environmentGroups?: ReleaseEnvironmentGroup[] }; hostConfig?: { root: string; files: Record<string, string> }; probes: Record<string, string>; name: string; repository: string; composePath: string; templatePath: string; expectedServices: string[]; activation: Record<string, boolean>; services: Array<{ name: string; image: string; tagPattern: string; deployServices?: string[]; deployServicesWithMigration?: string[] }>; infrastructure?: Array<{ name: string; image: string }>; }
function fail(message: string): never { throw new AppError(message, 409, "RELEASE_SOURCE_INVALID"); }
function parseManifest(value: unknown, stack: Stack): Manifest {
  const m = value as Manifest;
  if (!m || m.schemaVersion !== 2 || m.stack !== stack.name || typeof m.releaseId !== "string") fail("Invalid release manifest");
  if (releaseHash(Object.keys(m.services ?? {}).sort()) !== releaseHash(stack.services.map(s => s.name).sort())) fail("Manifest service set does not match platform configuration");
  if (releaseHash(Object.keys(m.infrastructure ?? {}).sort()) !== releaseHash((stack.infrastructure ?? []).map(s => s.name).sort())) fail("Manifest infrastructure set does not match platform configuration");
  for (const s of [...stack.services, ...(stack.infrastructure ?? [])]) {
    const image = m.services[s.name] ?? m.infrastructure?.[s.name];
    if (!image || image.image !== s.image || !/^sha256:[a-f0-9]{64}$/.test(image.digest)) fail("Manifest contains an unknown image or mutable digest");
    if (stack.services.some(x => x.name === s.name) && (!/^[a-f0-9]{40}$/.test(image.gitSha ?? "") || typeof image.migrationsChanged !== "boolean")) fail("Application source provenance is missing");
  }
  if (m.ossGitSha && !/^[a-f0-9]{40}$/.test(m.ossGitSha)) fail("Invalid OSS source SHA");
  return m;
}
export async function inspectRelease(ctx: ExecutionContext, b: ReleaseBinding, input: ReleasePlanInput) {
  const checks: ReleaseCheck[] = [];
  const check = (key: string, label: string, status: ReleaseCheck["status"], detail: string, blocking = true) => checks.push({ key, label, status, detail, blocking });
  const project = await repos.project.findById(b.projectId);
  if (!project || project.organizationId !== b.organizationId || ctx.organizationId !== b.organizationId) fail("Project scope does not match release binding");
  const source = `${project.gitOwner}/${project.gitRepo}`;
  if (source !== b.repository || project.hasBuild !== false || project.environmentType !== b.environment) fail("GitOps binding does not match the prebuilt project and environment");
  const main = await githubRead<{ sha: string }>(ctx, b, "commits/main");
  const config = YAML.parse(await githubFile(ctx, b, "platform.yaml", main.sha)) as { apiVersion: string; stacks: Stack[] };
  if (config.apiVersion !== "deploy/v2" || !Array.isArray(config.stacks)) fail("Invalid GitOps platform contract");
  const stack = config.stacks.find(s => s.name === b.stack);
  if (!stack || !Array.isArray(stack.expectedServices) || !Array.isArray(stack.services) || stack.composePath !== project.composePath || releaseHash([...stack.expectedServices].sort()) !== releaseHash([...b.expectedServices].sort())) fail("Binding service scope and source paths do not match the GitOps platform contract");
  if (releaseHash(b.probes) !== releaseHash([stack.probes?.[b.environment]])) fail("External probe does not match the bound GitOps environment");
  check("activation", "环境发布开关", stack.activation[b.environment] ? "pass" : "fail", stack.activation[b.environment] ? "已启用" : "此环境尚未通过接管与恢复验收");
  const branch = await githubRead<{ sha: string }>(ctx, b, `commits/${encodeURIComponent(b.targetBranch)}`);
  const branchManifest = YAML.parse(await githubFile(ctx, b, b.manifestPath, branch.sha));
  const branchCompose = YAML.parse(await githubFile(ctx, b, stack.composePath, branch.sha));
  const deployedManifest = parseManifest(branchManifest, observedManifestContract(stack, branchManifest, branchCompose));
  let manifest = structuredClone(deployedManifest), commit = branch.sha, eventKey: string | null = null, acceptedReceipt: Record<string, unknown> | null = null;
  let selected: string[] = [];
  const rollback = input.action === "rollback";
  const verification = input.action === "verify";
  if (verification) {
    if (b.environment !== "preview") fail("Verification workflow is restricted to PRT");
    if (input.manifestCommit && input.manifestCommit !== commit) fail("Verification target changed. Generate a fresh plan.");
  } else if (rollback) {
    if (!input.manifestCommit) fail("Rollback requires an exact accepted manifest commit");
    commit = input.manifestCommit;
    acceptedReceipt = JSON.parse(await githubFile(ctx, b, `accepted/${b.stack}/${commit}.json`, "release-audit"));
    manifest = parseManifest(YAML.parse(await githubFile(ctx, b, b.manifestPath, commit)), stack);
    if (acceptedReceipt!.status !== "accepted" || acceptedReceipt!.environment !== b.environment || acceptedReceipt!.projectId !== b.projectId || acceptedReceipt!.manifestCommit !== commit || manifestHash(acceptedReceipt!.manifest) !== manifestHash(manifest)) fail("Rollback target has no matching accepted receipt for this project and environment");
    check("rollback.epoch", "回退迁移边界", (deployedManifest.migrationEpoch ?? null) === (manifest.migrationEpoch ?? null) ? "pass" : "fail", "跨迁移边界不可自动回退数据库结构");
    selected = stack.services.filter(s => deployedManifest.services[s.name]!.digest !== manifest.services[s.name]!.digest).map(s => s.name);
    check("rollback.acceptance", "准确历史验收回执", "pass", "回退目标是本环境已验收的不可变清单");
  } else if (b.environment === "production") {
    const previewBindings = (await repos.releases.bindings()).filter(row => row.organizationId === b.organizationId && row.config.stack === b.stack && row.config.environment === "preview");
    if (previewBindings.length !== 1) fail("Exactly one verified PRT binding is required for this stack");
    const previewProject = await repos.project.findById(previewBindings[0]!.projectId);
    const previewActive = previewProject?.activeDeploymentId ? await repos.deployment.findById(previewProject.activeDeploymentId) : null;
    if (!previewActive?.commitSha || previewActive.status !== "ready") fail("PRT has no active ready candidate");
    commit = previewActive.commitSha;
    if (input.manifestCommit && input.manifestCommit !== commit) fail("PRT candidate changed. Generate a fresh plan.");
    manifest = parseManifest(YAML.parse(await githubFile(ctx, b, b.manifestPath, commit)), stack);
    try {
      acceptedReceipt = JSON.parse(await githubFile(ctx, b, `accepted/${b.stack}/${commit}.json`, "release-audit"));
      const receipt = acceptedReceipt!;
      const p = typeof receipt.projectId === "string" ? await repos.project.findById(receipt.projectId) : null;
      const d = typeof receipt.deploymentId === "string" ? await repos.deployment.findById(receipt.deploymentId) : null;
      if (receipt.status !== "accepted" || receipt.environment !== "preview" || receipt.manifestCommit !== commit || releaseHash(receipt.manifest) !== releaseHash(manifest) || p?.organizationId !== ctx.organizationId || p.environmentType !== "preview" || p.activeDeploymentId !== d?.id || d?.status !== "ready" || d.commitSha !== commit) fail("PRT acceptance is missing, stale or no longer active");
      check("prt.acceptance", "PRT 验收回执", "pass", "准确清单已验收且仍是活动部署");
    } catch { check("prt.acceptance", "PRT 验收回执", "unknown", "未取得仍有效的准确目标验收回执"); }
    const policy = JSON.parse(await githubFile(ctx, b, "config/production-operators.json", main.sha)) as { mode: string; operators: string[] };
    check("production.operators", "生产操作人策略", policy.mode === "manual-dispatch" && policy.operators?.length > 0 ? "pass" : "fail", "生产工作流会再次验证当前用户与重跑操作人");
  } else {
    // A selected event is processed alone. Preserve per-stack FIFO; do not drain a shared queue from one UI action.
    const pending: Array<{ key: string; receivedAt: string; payload: Record<string, unknown> }> = [];
    try {
      const inbox = await githubRead<{ sha: string }>(ctx, b, "commits/release-inbox");
      const files = await githubRead<Array<{ name: string; sha: string }>>(ctx, b, `contents/events?ref=${inbox.sha}`);
      if (files.length >= 1000) fail("Release inbox listing may be truncated");
      let receipts: Array<{ name: string; sha: string }> = [];
      try {
        const audit = await githubRead<{ sha: string }>(ctx, b, "commits/release-audit");
        receipts = await githubRead(ctx, b, `contents/receipts?ref=${audit.sha}`);
        if (receipts.length >= 1000) fail("Release receipt listing may be truncated");
      } catch (error) { if (!(error instanceof AppError) || error.statusCode !== 404) throw error; }
      const receiptByName = new Map(receipts.map(file => [file.name, file.sha]));
      for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f.name))) {
        const event = JSON.parse(await githubBlob(ctx, b, file.sha));
        if (event.payload?.stack !== b.stack) continue;
        let terminal = false;
        const receiptSha = receiptByName.get(`${event.key}.json`);
        if (receiptSha) { const receipt = JSON.parse(await githubBlob(ctx, b, receiptSha)); terminal = ["accepted", "superseded", "duplicate", "noop"].includes(receipt.status); }
        if (!terminal) pending.push(event);
      }
    } catch (error) { if (!(error instanceof AppError) || error.statusCode !== 404) throw error; }
    pending.sort((a, z) => a.receivedAt.localeCompare(z.receivedAt));
    const event = pending[0];
    if (input.eventKey && input.eventKey !== event?.key) fail("Selected event is not the next pending release for this stack");
    if (event) {
      const p = event.payload, name = String(p.service), spec = stack.services.find(s => s.name === name);
      if (!spec || p.repository !== stack.repository || p.image !== spec.image || !new RegExp(spec.tagPattern).test(String(p.tag)) || !/^[a-f0-9]{40}$/.test(String(p.gitSha)) || !/^sha256:[a-f0-9]{64}$/.test(String(p.digest)) || p.schemaVersion !== 2 || typeof p.migrationsChanged !== "boolean" || p.releaseId !== `${b.stack}:${String(p.gitSha).slice(0, 12)}` || createHash("sha256").update(`${b.stack}/${name}/${p.digest}`).digest("hex") !== event.key) {
        // Validate the producer's stable SHA-256 key separately from canonical JSON hashes.
        fail("Invalid release event provenance");
      }
      const before = manifest.services[name]!;
      const compare = await githubRead<{ status: string; total_commits: number; files?: Array<{ filename: string }> }>(ctx, { ...b, repository: stack.repository }, `compare/${before.gitSha}...${p.gitSha}`);
      if (!["ahead", "identical"].includes(compare.status) || compare.total_commits >= 250 || (compare.files?.length ?? 0) >= 300) fail("Source ancestry or complete change scope cannot be verified");
      if (compare.status === "identical" && before.digest !== p.digest && (b.stack !== "commercial-web" || manifest.ossGitSha === p.ossGitSha)) fail("Identical source produced a different digest");
      const migrationsChanged = p.migrationsChanged === true || (name === "platform-api" && migrationInputsChanged(compare.files ?? []));
      if (migrationsChanged && name !== "platform-api") fail("Only the migration-owning service can change database migrations");
      if (b.stack === "commercial-web" && p.ossGitSha) {
        if (!/^[a-f0-9]{40}$/.test(String(p.ossGitSha)) || !manifest.ossGitSha) fail("OSS provenance is missing");
        const oss = await githubRead<{ status: string }>(ctx, { ...b, repository: "Magic-Resume/Magic-Resume" }, `compare/${manifest.ossGitSha}...${p.ossGitSha}`);
        if (!["ahead", "identical"].includes(oss.status)) fail("OSS source history diverged or moved backwards");
      }
      eventKey = event.key;
      if (manifest.services[name]!.digest !== p.digest) {
        manifest.services[name] = { image: String(p.image), digest: String(p.digest), gitSha: String(p.gitSha), migrationsChanged, tag: String(p.tag) };
        manifest.releaseId = String(p.releaseId);
        delete manifest.bootstrap;
        if (p.ossGitSha) manifest.ossGitSha = String(p.ossGitSha);
        if (migrationsChanged) manifest.migrationEpoch = String(p.digest);
        selected = migrationsChanged ? spec.deployServicesWithMigration ?? [name] : spec.deployServices ?? [name];
      }
    }
    if (input.manifestCommit && input.manifestCommit !== commit) fail("The base manifest changed. Generate a fresh plan.");
  }
  if (b.environment === "production" && !rollback) selected = productionReleaseScope(stack.services, deployedManifest, manifest);
  const images: Record<string, ReleaseImage> = Object.fromEntries(Object.entries({ ...manifest.services, ...manifest.infrastructure }).map(([name, i]) => [name, { image: i.image, digest: i.digest, gitSha: i.gitSha ?? null }]));
  const template = await githubFile(ctx, b, stack.templatePath, main.sha);
  const configurationHash = gitopsConfigurationHash(template, stack);
  const rawCompose = renderGitopsCompose(template, stack, manifest);
  const target: ReleaseTarget = { action: verification ? "verify" : rollback ? "rollback" : "release", workflowSha: main.sha, manifestCommit: commit, manifestHash: manifestHash(manifest), configurationHash, releaseId: manifest.releaseId, images, ossGitSha: manifest.ossGitSha ?? null, services: [...new Set(selected)].sort(), eventKey, acceptedReceipt, manifest };
  const env: Record<string, string> = {};
  for (const row of await repos.project.listEnvVars(project.id, b.environment, null)) { try { env[row.key] = decrypt(row.value); } catch { fail("Saved environment configuration cannot be decrypted"); } }
  let parsed: ReturnType<typeof parseComposeFile>;
  try { parsed = parseComposeFile(rawCompose, { env }); } catch { fail("Compose configuration cannot be parsed"); }
  Object.assign(images, selectedImageExpectations(images, parsed!.services, selected));
  check("environment", "必需环境变量", parsed!.missingRequired.length ? "fail" : "pass", parsed!.missingRequired.length ? `缺少 ${parsed!.missingRequired.map(x => x.variable).join("、")}` : "必需变量已配置，值仅在服务器内解析");
  checks.push(...checkReleaseEnvironment(stack.releaseChecks?.environmentGroups ?? [], env));
  check("compose.scope", "服务集合与支持能力", releaseHash(parsed!.services.map(s => s.name).sort()) === releaseHash([...b.expectedServices].sort()) && !blockingComposeFields(parsed!.unsupported).length ? "pass" : "fail", "检查完整服务集合、端口、卷、外部网络与支持字段");
  const rows = await repos.service.listByProject(project.id);
  const runtimeScope = runtimeScopeCheck(rows.map(s => s.name), b.expectedServices, selected);
  check("runtime.scope", "平台服务集合", runtimeScope.status, runtimeScope.added.length && runtimeScope.status === "pass" ? `本次发布同步新增 ${runtimeScope.added.join("、")}` : "服务数量或名称变化需要先明确协调");
  const active = project.activeDeploymentId ? await repos.deployment.findById(project.activeDeploymentId) : null;
  const current: ReleaseObservation = { serverEnvironmentHash: await serverEnvironmentHash(project.id, b.environment), deploymentId: active?.id ?? null, images: {}, configurationHash: null, ossGitSha: null, verified: false };
  if (!active || active.organizationId !== b.organizationId || active.environment !== b.environment) { check("runtime.active", "活动部署", "unknown", "当前环境没有可确认的活动部署"); return { current, target, checks }; }
  // A desired branch can advance before deployment. Source metadata for the
  // running image must come from the incumbent's own immutable commit.
  const activeManifest = active.commitSha ? YAML.parse(await githubFile(ctx, b, b.manifestPath, active.commitSha)) : null;
  const activeCompose = active.commitSha ? YAML.parse(await githubFile(ctx, b, stack.composePath, active.commitSha)) : null;
  const actualManifest = activeManifest ? parseManifest(activeManifest, observedManifestContract(stack, activeManifest, activeCompose)) : null;
  check("runtime.source", "当前版本来源", actualManifest ? "pass" : "unknown", actualManifest ? "使用活动部署自身的固定清单与源码信息" : "活动部署缺少可确认的清单提交");
  const { runtime } = await resolveDeploymentRuntimeForRead(active);
  try {
    if (!(runtime instanceof DockerRuntime)) fail("GitOps requires Docker runtime attestation");
    if (stack.hostConfig) {
      try {
        const hashes = await inspectBoundHostConfiguration(runtime, b.stack, stack.hostConfig);
        check("configuration.files", "服务器配置文件", releaseHash(hashes) === releaseHash(stack.hostConfig.files) ? "pass" : "fail", "逐项核对准确配置目录内的文件内容摘要，仅显示验证状态");
      } catch { check("configuration.files", "服务器配置文件", "unknown", "服务器配置路径或文件内容摘要无法确认"); }
    }
    const savedRows = await repos.service.listByDeployment(active.id);
    const actualImages = { ...actualManifest?.services, ...actualManifest?.infrastructure };
    const { rows: deployedRows, unproven } = await observedServiceArtifacts(active, rows, savedRows, Object.keys(actualImages));
    // Missing target variables block the target, not observation of the
    // incumbent's own immutable Compose document and actual containers.
    const targetTopology = parsed.missingRequired.length ? null : await releaseTopologyVerifier(ctx, b, active, parsed, deployedRows);
    let topology: Awaited<ReturnType<typeof releaseTopologyVerifier>> | null = null;
    try { topology = await releaseTopologyVerifier(ctx, b, active, undefined, deployedRows); }
    catch { check("runtime.topology", "准确部署拓扑", "unknown", "已部署配置、端口、网络或卷归属无法确认"); }
    let verified = true;
    const converged = new Set<string>(), convergedToTarget = new Set<string>();
    for (const [name, expected] of Object.entries(actualImages)) {
      const service = rows.find(s => s.name === name), row = deployedRows.find(s => s.serviceId === service?.id);
      if (!row?.containerId) { verified = false; check(`runtime.${name}`, `${name} 实际容器`, "unknown", unproven.includes(name) ? "一次性任务的来源无法证明：其定义已不同于最近一次成功执行" : "未取得准确容器 ID"); continue; }
      try {
        const actual = await runtime.inspectReleaseContainer(row.containerId, expected.image);
        assertRetainedTaskContainer(active, name, row, actual);
        const targetResult = targetTopology ? targetTopology(name, actual) : missingTargetTopology(parsed.missingRequired);
        check(`target.topology.${name}`, `${name} 目标拓扑`, targetResult.status, targetResult.status === "pass" ? "目标保留现有端口、网络和卷归属" : targetResult.detail + "，需先协调拓扑变化");
        if (topology) {
          const result = topology(name, actual);
          check(`topology.${name}`, `${name} 端口、网络与卷`, result.status, result.detail);
        }
        const task = service?.advanced?.runToCompletion === true;
        const healthy = task ? actual.exitCode === 0 && !actual.running : actual.running && (actual.health === null || actual.health === "healthy");
        current.images[name] = { image: actual.image, digest: actual.digest, gitSha: actual.digest === expected.digest ? expected.gitSha ?? null : null };
        check(`runtime.${name}`, `${name} 实际容器`, healthy ? "pass" : "fail", healthy ? "运行状态已确认" : "容器停止、不健康或任务未成功完成");
        if (healthy && actual.digest === expected.digest) converged.add(name);
        if (healthy && actual.digest === images[name]?.digest) convergedToTarget.add(name);
      } catch { verified = false; check(`runtime.${name}`, `${name} 实际容器`, "unknown", "主机或镜像摘要无法确认"); }
    }
    current.verified = verified && actualManifest !== null;
    const oldTemplate = active.commitSha ? await githubFile(ctx, b, stack.templatePath, active.commitSha) : null;
    const oldConfig = active.commitSha ? YAML.parse(await githubFile(ctx, b, "platform.yaml", active.commitSha)) as { stacks: Stack[] } : null;
    const oldStack = oldConfig?.stacks?.find(s => s.name === b.stack);
    // Retain the immutable deployment's own hash separately for matched
    // desired-state recovery; live host attestation must not rewrite history.
    current.deploymentConfigurationHash = oldTemplate && oldStack ? gitopsConfigurationHash(oldTemplate, oldStack) : null;
    current.configurationHash = oldTemplate && oldStack ? observedGitopsConfigurationHash({
      preview: b.environment === "preview", template: oldTemplate, stack: oldStack,
      targetTemplate: template, targetStack: stack, imageServices: Object.keys(actualImages), checks,
    }) : null;
    current.ossGitSha = actualManifest && releaseHash(current.images) === releaseHash(Object.fromEntries(Object.entries({ ...actualManifest.services, ...actualManifest.infrastructure }).map(([name, i]) => [name, { image: i.image, digest: i.digest, gitSha: i.gitSha ?? null }]))) ? actualManifest.ossGitSha ?? null : null;
    // Resuming the same unfinished target rebuilds exactly what never converged;
    // every other service must still verify, and nothing else may change.
    let recovery = b.environment === "production" && !rollback && !verification && !selected.length
      ? productionRecoveryScope({ active: { status: active.status, decision: (active.meta as { composeDeployment?: { decision?: string } } | null)?.composeDeployment?.decision ?? null }, activeHash: actualManifest ? manifestHash(actualManifest) : null,
          deployedHash: manifestHash(deployedManifest), targetHash: manifestHash(manifest),
          activeConfiguration: current.deploymentConfigurationHash ?? null, targetConfiguration: configurationHash,
          expected: b.expectedServices, unconverged: Object.keys(actualImages).filter(name => !converged.has(name)),
          tasks: rows.filter(s => s.advanced?.runToCompletion === true).map(s => s.name) })
      : [];
    let recoveryDeploymentId = active.id, recoveryLabel = "部分失败的部署";
    if (!recovery.length && b.environment === "preview" && !rollback && !verification && !selected.length) {
      // A later run that failed before deploying (preflight, plan mismatch) changed no
      // containers, so it must not hide the unaccepted attempt that is still active.
      const latest = await releaseStore.latestStarted(b.projectId);
      const attempt = latest?.deploymentId ? await repos.deployment.findById(latest.deploymentId) : null;
      const owned = attempt && attempt.projectId === b.projectId && attempt.organizationId === b.organizationId && attempt.environment === b.environment && attempt.commitSha;
      const attemptManifest = owned ? YAML.parse(await githubFile(ctx, b, b.manifestPath, attempt.commitSha!)) : null;
      const attemptTemplate = owned ? await githubFile(ctx, b, stack.templatePath, attempt.commitSha!) : null;
      const attemptStack = owned ? (YAML.parse(await githubFile(ctx, b, "platform.yaml", attempt.commitSha!)) as { stacks: Stack[] }).stacks?.find(s => s.name === b.stack) : undefined;
      const scope = unacceptedAttemptRecoveryScope({
        run: latest ? { stage: latest.stage, deploymentId: latest.deploymentId } : null,
        attempt: owned ? { id: attempt.id, status: attempt.status } : null,
        attemptHash: attemptManifest ? manifestHash(attemptManifest) : null, deployedHash: manifestHash(deployedManifest), targetHash: manifestHash(manifest),
        attemptConfiguration: attemptTemplate && attemptStack ? gitopsConfigurationHash(attemptTemplate, attemptStack) : null, targetConfiguration: configurationHash,
        expected: b.expectedServices, unconverged: Object.keys(images).filter(name => !convergedToTarget.has(name)),
        tasks: rows.filter(s => s.advanced?.runToCompletion === true).map(s => s.name),
      });
      if (scope.length && attempt) { recovery = scope; recoveryDeploymentId = attempt.id; recoveryLabel = "替换后未通过验收的发布"; }
    }
    if (recovery.length) {
      selected = recovery;
      target.services = recovery;
      target.recovery = { deploymentId: recoveryDeploymentId, services: recovery };
      Object.assign(images, selectedImageExpectations(images, parsed.services, recovery));
      for (const item of checks) if (recovery.some(name => item.key === `runtime.${name}`)) { item.blocking = false; item.detail += "；恢复发布将重建此服务"; }
      check("recovery.scope", "未完成部署恢复", "pass", `继续${recoveryLabel} ${recoveryDeploymentId}，只重建未收敛的 ${recovery.join("、")}`);
    }
    if (selected.length && !rollback && !verification) {
      // Verify before mutate: acceptance proves untouched tasks only after containers
      // change. Render the incumbent with the same renderer so only real moves differ.
      let incumbent: ReturnType<typeof parseComposeFile>["services"] | null = null;
      try { incumbent = oldTemplate && oldStack && actualManifest ? parseComposeFile(renderGitopsCompose(oldTemplate, oldStack, actualManifest), { env }).services : null; } catch { incumbent = null; }
      const drifted = incumbent ? untouchedTaskDrift({ tasks: rows.filter(s => s.advanced?.runToCompletion === true).map(s => s.name), selected, incumbent: incumbent as unknown as Record<string, unknown>[], target: parsed!.services as unknown as Record<string, unknown>[] }) : null;
      check("task.scope", "范围外的一次性任务", drifted === null ? "unknown" : drifted.length ? "fail" : "pass",
        drifted === null ? "当前版本的任务定义无法解析" : drifted.length ? `${drifted.join("、")} 的定义随目标改变却不在发布范围内，替换容器后验收无法证明它，需加入范围` : "范围外的任务定义与当前版本一致");
    }
    const retained = recovery.length ? Object.keys(actualImages).filter(name => !recovery.includes(name)) : null;
    check("runtime.manifest", "运行镜像与已部署清单", retained ? (retained.every(name => converged.has(name)) ? "pass" : "fail") : verified ? (Object.entries(current.images).every(([name, i]) => i.digest === (deployedManifest.services[name] ?? deployedManifest.infrastructure?.[name])?.digest) ? "pass" : "fail") : "unknown", "实际摘要与当前环境清单逐项比对");
    if (b.stack === "magic-core" && target.services.includes("platform-api")) {
      const image = manifest.services["platform-api"]!;
      const database = deployedRows.find(row => row.serviceId === rows.find(s => s.name === "magic-postgres")?.id);
      try {
        if (!database?.containerId) throw new Error("Database container is unknown");
        const execution = await inspectMigrationExecution(ctx, b, stack.repository, image.gitSha!, runtime, database.containerId);
        const delta = execution.delta;
        target.migration = { phase: execution.phase, policyHash: execution.policyHash, sourceInventoryHash: execution.sourceInventoryHash,
          inventoryHash: delta.inventoryHash, deferredMigrations: execution.deferredMigrations, pendingMigrations: delta.pending, databaseContainerId: database.containerId };
        check("migration.phase", "镜像迁移阶段", "pass", execution.phase === "compatibility-a" ? "兼容 A：保留旧表，删除迁移仍未执行" : execution.phase === "complete" ? "删除迁移已在真实数据库执行，仅允许一致重跑" : "使用准确源码的完整迁移目录");
        check("migration.history", "实际数据库迁移记录", delta.failed.length || delta.unexpected.length || delta.modified.length ? "fail" : "pass", `${delta.pending.length} 条待迁移，${delta.failed.length} 条失败，${delta.unexpected.length} 条不属于目标版本，${delta.modified.length} 条内容不一致`);
        if (delta.pending.length) {
          check("migration.scope", "Compose 迁移任务", target.services.includes("migrate") ? "pass" : "fail", "有待迁移时准确服务范围必须包含既有 migrate 任务");
          try {
            const evidence = JSON.parse(await githubFile(ctx, b, `evidence/${b.stack}/${b.environment}/${image.gitSha}.json`, "release-audit"));
            const valid = migrationEvidenceMatches(evidence, { gitSha: image.gitSha!, digest: image.digest, environment: b.environment, deploymentId: active.id, databaseContainerId: database.containerId, execution }, delta);
            check("migration.evidence", "备份与隔离迁移演练", valid ? "pass" : "fail", valid ? "准确目标、当前数据库与动态迁移清单已有验证依据" : "演练依据不匹配当前数据库、准确目标或迁移清单");
          } catch { check("migration.evidence", "备份与隔离迁移演练", "unknown", "缺少准确目标的备份、隔离恢复与迁移验证依据"); }
        }
      } catch (error) { check("migration.history", "实际数据库迁移记录", error instanceof AppError && ["RELEASE_MIGRATION_POLICY_INVALID", "RELEASE_MIGRATION_LEDGER_INVALID"].includes(error.code ?? "") ? "fail" : "unknown", "目标迁移目录、执行策略或当前数据库记录无法确认"); }
    }
    for (const [name, image] of Object.entries(images)) { try { await runtime.inspectReleaseImage(`${image.image}@${image.digest}`); check(`image.${name}`, `${name} 镜像`, "pass", "镜像存在、摘要与主机架构匹配，拉取权限有效"); } catch { check(`image.${name}`, `${name} 镜像`, "unknown", "镜像存在性、架构或拉取权限无法确认"); } }
  } finally { disposeRuntime(runtime); }
  if (!target.services.includes("platform-api")) check("migration", "数据库迁移", "pass", "本次准确服务范围不涉及数据库迁移所属服务");
  if (verification) check("verification.target", "准确目标无操作验收", current.verified && current.configurationHash === target.configurationHash && releaseHash(current.images) === releaseHash(target.images) && current.ossGitSha === target.ossGitSha ? "pass" : "fail", "仅验证当前已运行的准确目标，不创建部署或历史 accepted 回执");
  const activeRun = await releaseStore.active(b.projectId);
  check("release.concurrent", "当前发布", activeRun ? "fail" : "pass", activeRun ? `已有发布 ${activeRun.id} 正在执行` : "没有正在执行的发布", false);
  const journals = await repos.releases.journals(b.projectId);
  check("recovery", "恢复条件", journals.some(j => !["committed", "restored"].includes(j.stage)) ? "fail" : "pass", "未完成的切换日志必须先恢复或协调");
  return { current, target, checks };
}
