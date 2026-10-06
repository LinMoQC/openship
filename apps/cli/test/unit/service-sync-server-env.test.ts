import { expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({ api: vi.fn(), spawn: vi.fn() }));
vi.mock("../../src/lib/ship-client", () => ({ hasShipCredentials: () => true, getShipClient: () => ({ services: { syncDocument: h.api } }), ApiError: class extends Error {} }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawnSync: h.spawn }));
import { serviceCommand } from "../../src/commands/service";

it("uploads untouched Compose references without invoking local Docker or needing application secrets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openship-sync-test-"));
  const file = path.join(dir, "compose.yml");
  const source = 'services:\n  app:\n    image: nginx@sha256:' + 'a'.repeat(64) + '\n    environment:\n      PASSWORD: ${SERVER_ONLY_PASSWORD:?required}\n';
  writeFileSync(file, source);
  h.api.mockResolvedValue([{ name: "app", id: "svc_app" }]);
  try {
    await serviceCommand.parseAsync(['sync', file, '--project', 'proj_test', '--server-env', 'preview', '--expected-services', 'app', '--release-run', 'rlr_test', '--manifest-commit', 'b'.repeat(40), '--yes'], { from: 'user' });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.api).toHaveBeenCalledOnce();
    expect(h.api.mock.calls[0]![0]).toBe('proj_test');
    expect(h.api.mock.calls[0]![1]).toEqual({ compose: source, environment: 'preview', expectedServices: ['app'], releaseRunId: 'rlr_test', manifestCommit: 'b'.repeat(40) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
