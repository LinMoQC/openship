# Stateless Compose health preflight

OpenShip's ordinary Compose replacement removes the old container before the new one is healthy. Docker HEALTHCHECK alone is advisory. With an opted-in post-start veto, a failed candidate could therefore leave a ready active-deployment record but no serving container.

Set `readiness.preflight: true` on a **stateless Docker Compose service/project** that can safely start a second process. Service readiness overrides the complete project readiness object. The flag defaults off. It is accepted by the project/service APIs and the `openship.json` parser.

```json
{
  "preflight": true,
  "enabled": true,
  "path": "/",
  "port": 3000,
  "timeoutSeconds": 60,
  "stabilization": true,
  "stabilizationSeconds": 120,
  "onFailure": "fail"
}
```

The preflight rejects configured mounts, image-declared anonymous volumes, shared namespaces, completion jobs, disabled/missing Docker healthchecks and non-Docker runtimes. This is explicit operator opt-in: lack of a volume does not establish that arbitrary application startup is free of external side effects.

1. Pull/inspect the candidate image before touching the incumbent. Both creates use the same local immutable image ID.
2. Start a temporary container with the same image, command, environment, healthcheck and resource caps, without published ports or the serving service's DNS alias. Its restart policy is `no`.
3. Require Docker `healthy` within `stabilizationSeconds` (default 120, maximum 600). `unhealthy`, exit, cancellation or timeout rejects the attempt. Remove the temporary container before cutover; cleanup failure vetoes cutover.
4. Stop and rename the incumbent, retaining its full Docker configuration. Start the replacement on the configured ports and require Docker health again. Activation failure removes the failed replacement, renames and restarts the same incumbent.
5. Retain the incumbent until the outer Compose deployment finishes its HTTP/stability checks and bookkeeping. Commit removes the stopped incumbent without pruning its volumes; failed gates or exceptions remove the replacement and restore the retained container.

The generic stop-first deployment pipeline delegates incumbent ownership to this transaction. Its previous container ID remains accurate, but it must not run its own pre-activation removal.

Unbound legacy deployments retain their in-memory transaction and can require manual recovery after controller loss. Registered GitOps releases persist a ServiceCutoverJournal before touching the incumbent, reconcile journal and actual containers after restart, and retain the incumbent until verified external acceptance. Accepted cleanup is retried without restoring an accepted release. Neither path promises zero downtime during a fixed-port switch. A failed candidate leaves the old port serving; failure after cutover has a recovery gap. Proxy changes and stateful stacks require separate procedures.

## Validation

- Adapter regression tests cover unhealthy/starting/cancelled candidates, candidate isolation, immutable image selection, volume/namespace refusals, retained-container commit/rollback, and activation start/health failures.
- Real Docker E2E drives the actual Compose deployment entry point, samples HTTP during a deliberately unhealthy candidate, verifies the original container ID survives, forces failure only after preflight, and exercises a later HTTP 503 veto before a successful replacement.
- Run: `RUN_DOCKER_E2E=1 bun run --cwd apps/api test:e2e test/e2e/stateless-candidate-health.e2e.test.ts`.
- The new test belongs to the required real-Docker release gate. An unreachable daemon or unavailable test image fails the run.
- `durable-cutover.e2e.test.ts` covers 22 durable scenarios, including literal process kills and reopen of the persisted journal. `core-migration-scope.e2e.test.ts` proves a failed real SQL completion job preserves the incumbent API and database volume.

Business production activation remains disabled. Runtime publication and isolated local tests are separate from actual control-platform maintenance and Admin → Web → Core PRT acceptance. See [the implementation and rollout gates](magic-v0.8-implementation.md).
