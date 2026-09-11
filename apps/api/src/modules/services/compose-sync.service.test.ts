import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../lib/request-context";

const h = vi.hoisted(() => ({ project: vi.fn(), vars: vi.fn(), services: vi.fn(), sync: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: {
  project: { findById: h.project, listEnvVars: h.vars }, service: { listByProject: h.services },
} }));
vi.mock("../../lib/controller-helpers", () => ({
  assertResourceInOrg: (p: { organizationId: string } | null, _label: string, org: string) => {
    if (!p || p.organizationId !== org) throw new Error("Project not found");
  },
}));
vi.mock("../../lib/encryption", () => ({ decrypt: (v: string) => {
  if (!v.startsWith("sealed:")) throw new Error("Invalid ciphertext");
  return v.slice(7);
} }));
vi.mock("./service.service", () => ({ syncComposeServices: h.sync }));
import { syncComposeDocument } from "./compose-sync.service";

const ctx = { organizationId: "org" } as RequestContext;
const image = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;
const compose = `services:
  app:
    image: ${image}
    environment:
      PASSWORD: \${PASSWORD:?required}
      LITERAL: $\${PASSWORD}
    ports: ["\${BIND:?}:\${PORT:?}:3000"]
`;
const input = { compose, environment: "preview", expectedServices: ["app"] } as const;
const call = (patch = {}) => syncComposeDocument(ctx, "proj_test", { ...input, expectedServices: ["app"], ...patch });

describe("server-side Compose sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.project.mockResolvedValue({ organizationId: "org", environmentType: "preview", hasBuild: false });
    h.vars.mockResolvedValue([
      { key: "PASSWORD", value: "sealed:server-only-value" },
      { key: "BIND", value: "sealed:127.0.0.1" },
      { key: "PORT", value: "sealed:19081" },
    ]);
    h.services.mockResolvedValue([]);
    h.sync.mockImplementation(async (_ctx, _id, services) => services);
  });
  it("resolves only the selected project's variables and returns masked values", async () => {
    const result = await call();
    expect(h.vars).toHaveBeenCalledWith("proj_test", "preview", null);
    const submitted = h.sync.mock.calls[0]![2][0];
    expect(submitted.ports).toEqual(["127.0.0.1:19081:3000"]);
    expect(submitted.environment.PASSWORD).toBe("server-only-value");
    expect(submitted.environment.LITERAL).toBe("${PASSWORD}");
    expect(submitted.environmentTemplates).toMatchObject({ PASSWORD: "${PASSWORD:?required}", LITERAL: "$${PASSWORD}" });
    expect(JSON.stringify(result)).not.toContain("server-only-value");
    expect(result[0]!.environment).toEqual({ PASSWORD: "••••••••", LITERAL: "••••••••" });
    expect(result[0]).not.toHaveProperty("environmentTemplates");
  });
  it("does not read secrets for another tenant or environment", async () => {
    h.project.mockResolvedValue({ organizationId: "other", environmentType: "preview", hasBuild: false });
    await expect(call()).rejects.toThrow("Project not found");
    expect(h.vars).not.toHaveBeenCalled();
    h.project.mockResolvedValue({ organizationId: "org", environmentType: "production", hasBuild: false });
    await expect(call()).rejects.toThrow("matching prebuilt");
    expect(h.vars).not.toHaveBeenCalled();
  });
  it("rejects missing required values and unreadable secrets without syncing", async () => {
    h.vars.mockResolvedValue([]);
    await expect(call()).rejects.toThrow("missing required");
    h.vars.mockResolvedValue([{ key: "PASSWORD", value: "unreadable-secret" }]);
    await expect(call()).rejects.toThrow("could not be decrypted");
    expect(h.sync).not.toHaveBeenCalled();
  });
  it("rejects incomplete expected sets and refuses implicit service deletion", async () => {
    await expect(call({ expectedServices: ["app", "db"] })).rejects.toThrow("complete expected set");
    h.services.mockResolvedValue([{ name: "app" }, { name: "db" }]);
    await expect(call()).rejects.toThrow("remove an existing service");
    expect(h.sync).not.toHaveBeenCalled();
  });
  it("refuses builds, mutable images, unsupported runtime fields and invalid YAML", async () => {
    await expect(call({ compose: compose.replace(image, "nginx:latest") })).rejects.toThrow("pinned by digest");
    await expect(call({ compose: compose.replace("    image:", "    build: .\n    image:") })).rejects.toThrow("prebuilt image");
    await expect(call({ compose: compose.replace("    image:", "    network_mode: host\n    image:") })).rejects.toThrow("unsupported runtime");
    await expect(call({ compose: "services: [secret-value" })).rejects.toThrow("Invalid Compose document");
    expect(h.sync).not.toHaveBeenCalled();
  });
});
