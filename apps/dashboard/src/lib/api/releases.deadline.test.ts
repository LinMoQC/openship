import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./urls", () => ({ getRestApiBaseUrl: () => "http://localhost/api/" }));
import { releasesApi } from "./releases";
import { api } from "./client";
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function delayedFetch(delay: number) {
  const fetch = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ data: { kind: "unknown" } }), { headers: { "content-type": "application/json" } })), delay);
    options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); });
  }));
  vi.stubGlobal("fetch", fetch); return fetch;
}
describe("release inspection deadlines", () => {
  it("returns a remote unknown state after 29 seconds while ordinary reads retain 15 seconds", async () => {
    delayedFetch(29_000);
    const ordinary = api.get("ordinary").catch(error => error);
    const result = releasesApi.state("admin", true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(await ordinary).toMatchObject({ name: "AbortError" });
    expect((await result).data.kind).toBe("unknown");
  });
  it("bounds a slow submission without replaying it or changing its idempotency key", async () => {
    const fetch = delayedFetch(130_000);
    const result = releasesApi.start("plan", "same_idempotency_key").catch(error => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await result).name).toBe("AbortError"); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ idempotencyKey: "same_idempotency_key" });
  });
});
