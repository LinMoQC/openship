// A real process boundary for Docker recovery tests. Receives only an isolated
// test payload and journal directory; never imports platform credentials.
import { readFileSync } from "node:fs";
import Dockerode from "dockerode";
import { PGlite } from "@electric-sql/pglite";
import { deployPreflightedService } from "../../../../packages/adapters/src/runtime/docker-preflight";

const [inputPath, journalPath, stopAt] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath!, "utf8"));
const database = new PGlite(journalPath!);
await database.exec("CREATE TABLE IF NOT EXISTS cutover (id text PRIMARY KEY, record jsonb NOT NULL)");
await deployPreflightedService(new Dockerode({ socketPath: input.socketPath }), input.target, {
  timeoutMs: 10_000,
  journal: {
    releaseRunId: input.releaseRunId, previousDeploymentId: input.previousDeploymentId,
    async save(record) {
      await database.query("INSERT INTO cutover(id,record) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET record=excluded.record", [record.id, record]);
      await database.exec("CHECKPOINT");
      if (record.stage === stopAt) {
        process.stdout.write("CUTOVER_INTENT_DURABLE\n");
        await new Promise(() => { setInterval(() => {}, 1000); }); // Parent sends SIGKILL; no rollback closure runs.
      }
    },
  },
}, () => {});
throw new Error("Crash injection stage was not reached");
