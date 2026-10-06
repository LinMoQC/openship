import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createMigrationChecksumCache } from "../src/gitops-migration-checksums";
const sql = Buffer.from("SELECT 1;\n");
const sha = createHash("sha1").update(`blob ${sql.length}\0`).update(sql).digest("hex");
const blob = { encoding: "base64", content: sql.toString("base64") };
it("shares verified immutable checksums without retaining cross-repository authorization", async () => {
  const cache = createMigrationChecksumCache(), load = vi.fn(async () => blob);
  const hashes = await Promise.all([cache("owner/a", sha, load), cache("owner/a", sha, load)]);
  expect(hashes).toEqual(Array(2).fill(createHash("sha256").update(sql).digest("hex")));
  expect(load).toHaveBeenCalledOnce();
  await cache("owner/b", sha, load);
  expect(load).toHaveBeenCalledTimes(2);
});
it("never caches failed or substituted migration content", async () => {
  const cache = createMigrationChecksumCache(), load = vi.fn().mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({ ...blob, content: Buffer.from("SELECT 2;").toString("base64") }).mockResolvedValue(blob);
  await expect(cache("owner/a", sha, load)).rejects.toThrow("Unavailable");
  await expect(cache("owner/a", sha, load)).rejects.toThrow("identity differs");
  await expect(cache("owner/a", sha, load)).resolves.toMatch(/^[a-f0-9]{64}$/);
  expect(load).toHaveBeenCalledTimes(3);
});
it("bounds storage and rereads evicted checksums", async () => {
  const cache = createMigrationChecksumCache(1), load = vi.fn(async () => blob);
  await cache("owner/a", sha, load); await cache("owner/b", sha, load); await cache("owner/a", sha, load);
  expect(load).toHaveBeenCalledTimes(3);
});
