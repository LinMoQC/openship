import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createGitopsGate, requireUnmanagedProject } from "../src/gitops-gate";
import { assertDeploymentsAvailable } from "../src/deployment-maintenance";

let directory: string;
afterEach(() => { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }); });
it("freezes both ordinary and registered controller deployment before inspecting configuration", async () => {
  directory = mkdtempSync(join(tmpdir(), "openship-maintenance-"));
  const marker = join(directory, "frozen"); vi.stubEnv("OPENSHIP_DEPLOYMENT_FREEZE_FILE", marker);
  expect(() => assertDeploymentsAvailable()).not.toThrow(); writeFileSync(marker, "maintenance");
  const binding = vi.fn();
  const gate = createGitopsGate({ binding } as Parameters<typeof createGitopsGate>[0]);
  await expect(gate({} as Parameters<typeof gate>[0], "project", { releaseRunId: "registered" })).rejects.toMatchObject({ code: "DEPLOYMENT_MAINTENANCE" });
  await expect(requireUnmanagedProject("ordinary", binding)).rejects.toMatchObject({ code: "DEPLOYMENT_MAINTENANCE" });
  expect(binding).not.toHaveBeenCalled();
  rmSync(marker); expect(() => assertDeploymentsAvailable()).not.toThrow();
});
