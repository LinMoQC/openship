import { expect, it } from "vitest";
import { Hono } from "hono";
import { repos } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { seedOwner } from "../jobs/_harness";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { deploymentRoutes } from "../../../src/modules/deployments/deployment.routes";
import { serviceRoutes } from "../../../src/modules/services/service.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { releaseProjectRoutes, releaseCapabilityRoutes } from "../../../src/modules/releases/release.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono().onError(handleApiError)
  .route("/api/health", healthRoutes).route("/api/projects", projectRoutes)
  .route("/api/projects/:id", releaseProjectRoutes).route("/api/releases", releaseCapabilityRoutes)
  .route("/api/deployments", deploymentRoutes).route("/api/projects/:id/services", serviceRoutes);
const remote = (token: string, organizationId: string) => new OpenshipClient({
  baseUrl: "http://openship.test", token, organizationId,
  fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
});

it("HTTP and native SDK reject bound legacy mutation before creating deployment or service records", async () => {
  const owner = await seedOwner(), user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user: { id: user.id, email: user.email, name: user.name }, sessionId: "gitops-test" }) } });
  const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
  for (const [index, client] of [native, remote(owner.token, owner.orgId)].entries()) {
    const project = await client.projects.create({ name: `GitOps ${index}`, publicEndpoints: [] });
    await client.projects.update(project.id, { startCommand: "initial" });
    await client.releases.bind(project.id, {
      environment: "preview", stack: "admin", repository: "example/config", manifestPath: "stacks/admin/release.yaml",
      targetBranch: "deploy/prt", workflowRef: "main", workflows: { preview: "receive.yml", production: "promote.yml", rollback: "rollback.yml" },
      controllerTokenIds: ["fixture-controller"], expectedServices: ["admin"], probes: ["https://example.invalid/health"],
    });
    await expect(client.projects.update(project.id, { startCommand: "changed" })).rejects.toMatchObject({ code: "GITOPS_RELEASE_REQUIRED" });
    await expect(client.projects.setOptions(project.id, { autoDeploy: true })).rejects.toMatchObject({ code: "GITOPS_RELEASE_REQUIRED" });
    await expect(client.deployments.create({ projectId: project.id })).rejects.toMatchObject({ code: "GITOPS_RELEASE_REQUIRED" });
    await expect(client.services.sync(project.id, { services: [{ name: "admin", image: "example/admin" }] })).rejects.toMatchObject({ code: "GITOPS_RELEASE_REQUIRED" });
    expect((await repos.project.findById(project.id))!.startCommand).toBe("initial");
    expect(await repos.service.listByProject(project.id)).toEqual([]);
    expect(await client.releases.latest(project.id)).toBeNull();
  }
});

it("a project controller can read its runtime contract without global update permission or another project", async () => {
  const owner = await seedOwner(), user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user: { id: user.id, email: user.email, name: user.name }, sessionId: "gitops-scope" }) } });
  const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
  const project = await native.projects.create({ name: "Controller scope", publicEndpoints: [] });
  const other = await native.projects.create({ name: "Other scope", publicEndpoints: [] });
  const pat = mintPatToken();
  await repos.personalAccessToken.createWithGrants({ userId: user.id, organizationId: owner.orgId, name: "controller", tokenPrefix: pat.tokenPrefix, tokenHash: pat.tokenHash, readOnly: false, scoped: true, expiresAt: null }, [{ resourceType: "project", resourceId: project.id, permissions: ["read", "write"] }]);
  const client = remote(pat.token, owner.orgId);
  expect(await client.releases.capabilities(project.id)).toMatchObject({ contractVersion: 1, gitops: true });
  await expect(client.releases.capabilities()).rejects.toThrow();
  await expect(client.releases.capabilities(other.id)).rejects.toThrow();
});
