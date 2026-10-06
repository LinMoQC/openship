import { mkdtemp, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createHostExecutor } from "../system/executor";
import { inspectHostConfiguration } from "./host-config-inspection";

it("reads actual local configuration hashes, detects changed files, and refuses symlink escape", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openship-host-config-"))), outside = await realpath(await mkdtemp(join(tmpdir(), "openship-host-outside-")));
  try {
    await writeFile(join(directory, "file.conf"), "private fixture configuration");
    const hashes = await inspectHostConfiguration(createHostExecutor(), directory, ["file.conf"]);
    expect(hashes).toEqual({ "file.conf": createHash("sha256").update("private fixture configuration").digest("hex") });
    expect(JSON.stringify(hashes)).not.toContain("private fixture");
    await writeFile(join(directory, "file.conf"), "changed");
    expect(await inspectHostConfiguration(createHostExecutor(), directory, ["file.conf"])).not.toEqual(hashes);
    await writeFile(join(outside, "unbound.conf"), "never returned");
    await symlink(join(outside, "unbound.conf"), join(directory, "escape.conf"));
    await expect(inspectHostConfiguration(createHostExecutor(), directory, ["escape.conf"])).rejects.toThrow();
    await expect(inspectHostConfiguration(createHostExecutor(), directory, ["../unbound.conf"])).rejects.toThrow(/scope/);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
