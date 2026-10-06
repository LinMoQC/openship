import { createHash } from "node:crypto";

/** Cache only verified immutable checksums, never SQL or credentials. */
export function createMigrationChecksumCache(limit = 1024) {
  const values = new Map<string, Promise<string>>();
  return async (repository: string, sha: string, load: () => Promise<{ content: string; encoding: string }>) => {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid migration blob identity");
    const key = `${repository}:${sha}`;
    const found = values.get(key);
    if (found) { values.delete(key); values.set(key, found); return found; }
    const pending = (async () => {
      const blob = await load();
      if (blob.encoding !== "base64") throw new Error("Migration blob encoding is unknown");
      const sql = Buffer.from(blob.content, "base64");
      if (createHash("sha1").update(`blob ${sql.length}\0`).update(sql).digest("hex") !== sha) throw new Error("Migration blob identity differs");
      return createHash("sha256").update(sql).digest("hex");
    })();
    values.set(key, pending);
    while (values.size > limit) values.delete(values.keys().next().value!);
    try { return await pending; }
    catch (error) { if (values.get(key) === pending) values.delete(key); throw error; }
  };
}
