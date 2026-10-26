import { describe, expect, it } from "vitest";
import { pendingInboxEvents } from "../src/engine/modules/releases/release-inbox";

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
function inbox(count: number, stackOf: (i: number) => string, statusOf: (i: number) => string | null) {
  const blobs = new Map<string, string>();
  const files: Array<{ name: string; sha: string }> = [];
  const receipts: Array<{ name: string; sha: string }> = [];
  for (let i = 0; i < count; i++) {
    const key = hex(i, 64);
    const eventSha = hex(i, 40);
    blobs.set(eventSha, JSON.stringify({ key, receivedAt: `2026-10-${String(10 + (count - i) % 20).padStart(2, "0")}T00:00:${hex(i % 60, 2)}Z`, payload: { stack: stackOf(i) } }));
    files.push({ name: `${key}.json`, sha: eventSha });
    const status = statusOf(i);
    if (status) {
      const receiptSha = hex(100_000 + i, 40);
      blobs.set(receiptSha, JSON.stringify({ status }));
      receipts.push({ name: `${key}.json`, sha: receiptSha });
    }
  }
  return { blobs, files, receipts };
}

describe("release inbox scan", () => {
  it("returns this stack's events without a terminal receipt", async () => {
    const { blobs, files, receipts } = inbox(12, i => (i % 3 === 0 ? "admin" : "magic-core"), i => (i < 6 ? "accepted" : i === 7 ? "failed" : null));
    const pending = await pendingInboxEvents(async sha => blobs.get(sha)!, "magic-core", [...files, { name: "README.md", sha: hex(999, 40) }], receipts);
    expect(pending.map(event => event.key)).toEqual([7, 8, 10, 11].map(i => hex(i, 64)));
  });

  it("reads blobs concurrently, never above the limit", async () => {
    const { blobs, files, receipts } = inbox(40, () => "magic-core", () => "accepted");
    let inFlight = 0, peak = 0, reads = 0;
    const pending = await pendingInboxEvents(async sha => {
      inFlight++; reads++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return blobs.get(sha)!;
    }, "magic-core", files, receipts, 8);
    expect(pending).toEqual([]);
    expect(reads).toBe(80);
    expect(peak).toBe(8);
  });

  it("fails the scan on the first failed read and stops issuing new reads", async () => {
    const { blobs, files, receipts } = inbox(40, () => "magic-core", () => null);
    let reads = 0;
    await expect(pendingInboxEvents(async sha => {
      const read = ++reads;
      await new Promise(resolve => setTimeout(resolve, 2));
      if (read === 3) throw new Error("GitHub unavailable");
      return blobs.get(sha)!;
    }, "magic-core", files, receipts, 4)).rejects.toThrow("GitHub unavailable");
    expect(reads).toBeLessThan(40);
  });
});
