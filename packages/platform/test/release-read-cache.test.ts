import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../src/context";
import type { ReleaseBinding } from "@repo/contracts";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/engine/modules/github/github.auth", () => ({ githubFetch: mocks.fetch, getUserToken: vi.fn() }));
vi.mock("../src/engine/modules/github/github.http", () => ({ ghFetch: vi.fn() }));
import { githubRead, githubFile, githubBlob } from "../src/engine/modules/releases/release-github";
const ctx = { userId: "owner", organizationId: "org", source: "dashboard", tokenScope: null } as ExecutionContext;
const b = { repository: "owner/repo" } as ReleaseBinding;
const sha = "a".repeat(40);
describe("immutable release reads", () => {
  beforeEach(() => { mocks.fetch.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });
  it("reuses and coalesces a frozen directory listing", async () => {
    mocks.fetch.mockResolvedValue([{ name: "event.json", sha: "b".repeat(40) }]);
    await Promise.all(Array.from({ length: 5 }, () => githubRead(ctx, b, `contents/events?ref=${sha}`)));
    await githubRead(ctx, b, `contents/events?ref=${sha}`);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it("does not cache branch heads or files addressed by a mutable ref", async () => {
    mocks.fetch.mockResolvedValue({ encoding: "base64", content: Buffer.from("value").toString("base64") });
    await githubFile(ctx, b, "release.yaml", "deploy/prt"); await githubFile(ctx, b, "release.yaml", "deploy/prt");
    await githubRead(ctx, b, "commits/main"); await githubRead(ctx, b, "commits/main");
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });
  it("isolates another user, organization, and controller token", async () => {
    mocks.fetch.mockResolvedValue({ result: "safe" });
    const path = `contents/scope?ref=${sha}`;
    await githubRead(ctx,b,path);
    await githubRead({...ctx,userId:"other"},b,path);
    await githubRead({...ctx,organizationId:"other"},b,path);
    await githubRead({...ctx,tokenScope:{tokenId:"controller"}} as ExecutionContext,b,path);
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });
  it("reuses a verified immutable event blob across later inbox commits", async () => {
    const bytes = Buffer.from('{"event":"immutable"}');
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    mocks.fetch.mockResolvedValue({ sha:hash, encoding:"base64", content:bytes.toString("base64") });
    expect(await githubBlob(ctx,b,hash)).toBe(bytes.toString());
    expect(await githubBlob(ctx,b,hash)).toBe(bytes.toString());
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it("rejects mismatched blob content without poisoning a later valid read", async () => {
    const bytes=Buffer.from("correct"), hash=createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    mocks.fetch.mockResolvedValueOnce({sha:hash,encoding:"base64",content:Buffer.from("changed").toString("base64")})
      .mockResolvedValueOnce({sha:hash,encoding:"base64",content:bytes.toString("base64")});
    await expect(githubBlob(ctx,b,hash)).rejects.toMatchObject({code:"RELEASE_SOURCE_UNAVAILABLE"});
    expect(await githubBlob(ctx,b,hash)).toBe("correct");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("expires immutable reads and keeps caller mutations out of cached evidence", async () => {
    vi.useFakeTimers();
    const path=`contents/expiration?ref=${sha}`;
    mocks.fetch.mockResolvedValue({proof:"original"});
    const value=await githubRead<{proof:string}>(ctx,b,path); value.proof="changed by caller";
    expect(await githubRead(ctx,b,path)).toEqual({proof:"original"});
    expect(mocks.fetch).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30*60_000+1);
    await githubRead(ctx,b,path); expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("does not cache failed reads", async () => {
    const path=`contents/retry?ref=${sha}`;
    mocks.fetch.mockRejectedValueOnce({status:503}).mockResolvedValueOnce({ok:true});
    await expect(githubRead(ctx,b,path)).rejects.toMatchObject({code:"RELEASE_SOURCE_UNAVAILABLE"});
    await githubRead(ctx,b,path); expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
