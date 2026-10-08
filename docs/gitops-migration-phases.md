# GitOps migration phases and incumbent scope

Release inspection reads the running environment's manifest and locked Compose from the incumbent's immutable deployment commit. A smaller established deployment is checked against its own locked service set and immutable image digests. This does not make it the expanded target: target scope, activation, topology, recovery and PRT acceptance remain separate blocking checks. Unknown services, mutable images and mismatched migration-job images are rejected.

Core images may include `packages/db/runtime/migration-compatibility-policy.json`. The inspector verifies every migration name and SQL checksum against the exact image source tree. A missing policy keeps the existing full-source behavior. An invalid policy blocks release; it never falls back to a full deletion.

The supported policy defers only `20260815020000_ai_credit_unification_release_b`, with its original checksum. A database without a successfully completed matching deletion uses `compatibility-a`; the deletion stays visibly deferred and absent from the execution inventory. Failed or modified history remains blocking. A database that genuinely completed B uses `complete`. Inspection does not create or rewrite Prisma records.

Release plans retain `target.migration`: phase, policy hash, full-source and execution inventory hashes, pending and deferred migration names, and the actual database container ID. Backup/restore/migration evidence for policy-bearing images must match this exact phase and immutable identity as well as the image, environment and current database. Legacy full-inventory evidence cannot certify a compatibility run.

Execution rechecks the phase, policy, SQL inventories and actual ledger. Resolving the planned pending migrations is allowed between the migration job and application deployment; changing phase or introducing failed, modified or unknown history is not. Only the existing Compose migrate job performs migrations. Changes to its runtime policy, Prisma configuration or package entrypoint require the same migration service scope as SQL changes.

This is preflight support, not production activation or acceptance. It does not establish compatibility of older payment writers after a unique-index migration, authorize database rollback, or replace exact-image isolation and application recovery evidence.
