import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/engine/lib/cache-store/index", () => ({ cacheStore: vi.fn() }));
import { ghFetch, ghSend, GitHubApiError } from "../src/engine/modules/github/github.http";
describe("GitHub REST cooldown", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T10:00:00Z")); fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("honors the shared token's primary reset for reads and writes without retrying", async () => {
    const reset = Date.now() / 1000 + 3600;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "rate limit" }), { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "core" } }));
    await expect(ghFetch("primary-token", { url: "https://api.github.com/repos/o/r/commits/main" })).rejects.toMatchObject({ retryAt: reset * 1000 });
    await expect(ghFetch("primary-token", { url: "https://api.github.com/repos/o/r/contents/x" })).rejects.toBeInstanceOf(GitHubApiError);
    await expect(ghSend("primary-token", { url: "https://api.github.com/repos/o/r/actions/workflows/x/dispatches", method: "POST" })).rejects.toBeInstanceOf(GitHubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_600_001); fetchMock.mockResolvedValueOnce(new Response('{}'));
    await ghFetch("primary-token", { url: "https://api.github.com/repos/o/r/commits/main" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("honors Retry-After for secondary limits", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"message":"secondary rate limit"}', { status: 429, headers: { "retry-after": "120" } }));
    await expect(ghFetch("secondary-token", { url: "https://api.github.com/repos/o/r" })).rejects.toMatchObject({ retryAt: Date.now() + 120_000 });
    await expect(ghFetch("secondary-token", { url: "https://api.github.com/repos/o/r" })).rejects.toBeInstanceOf(GitHubApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("records quota exhaustion on the last successful response and allows quota inspection", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}',{headers:{"x-ratelimit-remaining":"0","x-ratelimit-reset":String(Date.now()/1000+600)}}));
    await ghFetch("last-success-token",{url:"https://api.github.com/repos/o/r"});
    await expect(ghFetch("last-success-token",{url:"https://api.github.com/repos/o/r/commits/main"})).rejects.toBeInstanceOf(GitHubApiError);
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    await ghFetch("last-success-token",{url:"https://api.github.com/rate_limit"});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("isolates token, API host and resource buckets", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"message":"limited"}', { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.now()/1000+600) } }));
    await expect(ghFetch("isolated-token", { url: "https://api.github.com/repos/o/r" })).rejects.toBeInstanceOf(GitHubApiError);
    fetchMock.mockImplementation(async () => new Response('{}'));
    await ghFetch("other-token", { url: "https://api.github.com/repos/o/r" });
    await ghFetch("isolated-token", { url: "https://github.example/api/v3/repos/o/r" });
    await ghFetch("isolated-token", { url: "https://api.github.com/search/repositories" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("does not treat a rejected credential as a rate limit", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"message":"forbidden"}', { status: 403 }));
    await expect(ghFetch("rejected-token", { url: "https://api.github.com/repos/o/r" })).rejects.toMatchObject({ credentialRejected: true });
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    await ghFetch("rejected-token", { url: "https://api.github.com/repos/o/r" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
