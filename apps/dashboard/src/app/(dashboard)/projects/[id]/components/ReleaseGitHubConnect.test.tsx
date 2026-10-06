// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import copy from "@/i18n/locales/en/projects.json";
import { ReleaseGitHubConnect } from "./ReleaseGitHubConnect";

const h = vi.hoisted(() => ({ get: vi.fn(), linkSocial: vi.fn() }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: { projects: copy } }) }));
vi.mock("@/lib/auth-client", () => ({ authClient: { linkSocial: h.linkSocial } }));
vi.mock("@/lib/api/client", () => ({ api: { get: h.get }, getApiErrorMessage: (_: unknown, fallback: string) => fallback }));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.get.mockResolvedValue({ authProviders: [{ id: "github", kind: "social" }] });
  h.linkSocial.mockResolvedValue({ data: { url: "https://github.com/login/oauth/authorize" }, error: null });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click() {
  await act(async () => root.render(<ReleaseGitHubConnect />));
  await act(async () => container.querySelector("button")!.click());
}
describe("release operator GitHub authorization", () => {
  it("links the signed-in user with explicit repository scope and returns to this release", async () => {
    await click();
    expect(h.get).toHaveBeenCalledWith("health/env");
    expect(h.linkSocial).toHaveBeenCalledOnce();
    expect(h.linkSocial).toHaveBeenCalledWith({ provider: "github", scopes: ["repo"], callbackURL: window.location.href, errorCallbackURL: window.location.href });
  });
  it("explains missing OAuth configuration without starting another identity flow", async () => {
    h.get.mockResolvedValue({ authProviders: [] }); await click();
    expect(h.linkSocial).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(copy.release.githubSetup);
  });
  it("shows a provider refusal and permits another connection attempt", async () => {
    h.linkSocial.mockResolvedValue({ error: { message: "Repository access was refused" } }); await click();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Repository access was refused");
    expect(container.querySelector("button")?.disabled).toBe(false);
  });
  it("does not start authorization if the provider check cannot be confirmed", async () => {
    h.get.mockRejectedValue(new Error("offline")); await click();
    expect(h.linkSocial).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(copy.release.githubLinkError);
  });
});
