# v0.8 custom path inventory

The original 42-file delta is computed from `30ae48a4d67aabe8502df2a8393753443cb0637a` to `4c945f1d91fc034d6bba65423883676dec2af3dc`. Shared execution moved from API modules to Platform; wire schemas moved to Contracts. Tests remain under API when they exercise its integration harness. Every destination listed below exists in this adaptation.

Behavioral disposition and regression coverage are recorded in [magic-v0.8-implementation.md](magic-v0.8-implementation.md). Later live fixes are listed separately there, including new result-status and scoped-reject modules. This inventory records file responsibility, not a claim that upstream code is byte-identical.

| Original path | v0.8 responsibility |
| --- | --- |
| `.github/workflows/magic-runtime.yml` | `.github/workflows/magic-runtime.yml` |
| `apps/api/src/lib/compose-parser.ts` | `packages/platform/src/engine/lib/compose-parser.ts` |
| `apps/api/src/lib/route-permission.ts` | `apps/api/src/lib/route-permission.ts` |
| `apps/api/src/modules/backups/service-handle.ts` | `packages/platform/src/engine/modules/backups/service-handle.ts` |
| `apps/api/src/modules/deployments/compose/deploy.service.ts` | `packages/platform/src/engine/modules/deployments/compose/deploy.service.ts` |
| `apps/api/src/modules/deployments/compose/force-pull.test.ts` | `apps/api/src/modules/deployments/compose/force-pull.test.ts` |
| `apps/api/src/modules/deployments/deployment.schema.ts` | `packages/contracts/src/deployments.ts`; `packages/contracts/src/deployment-inputs.ts` |
| `apps/api/src/modules/deployments/readiness-gate.ts` | `packages/platform/src/engine/modules/deployments/readiness-gate.ts` |
| `apps/api/src/modules/projects/project-environment.controller.test.ts` | `apps/api/src/modules/projects/project-environment-create.test.ts`; `apps/api/test/modules/projects/project-environment-access.test.ts` |
| `apps/api/src/modules/projects/project.controller.ts` | `apps/api/src/modules/projects/project.controller.ts`; `packages/platform/src/engine/modules/projects/project-crud.service.ts` |
| `apps/api/src/modules/projects/project.schema.ts` | `packages/contracts/src/project-inputs.ts` |
| `apps/api/src/modules/services/compose-sync.service.test.ts` | `apps/api/src/modules/services/compose-sync.service.test.ts` |
| `apps/api/src/modules/services/compose-sync.service.ts` | `packages/platform/src/engine/modules/services/compose-sync.service.ts` |
| `apps/api/src/modules/services/service.controller.ts` | `apps/api/src/modules/services/service.controller.ts` |
| `apps/api/src/modules/services/service.routes.ts` | `apps/api/src/modules/services/service.routes.ts` |
| `apps/api/src/modules/services/service.schema.ts` | `packages/contracts/src/service-inputs.ts` |
| `apps/api/test/e2e/stateless-candidate-health.e2e.test.ts` | `apps/api/test/e2e/stateless-candidate-health.e2e.test.ts` |
| `apps/api/test/lib/compose-parser.test.ts` | `apps/api/test/lib/compose-parser.test.ts` |
| `apps/api/test/lib/permission-nested-list-parent.test.ts` | `apps/api/test/lib/permission-nested-list-parent.test.ts` |
| `apps/api/test/modules/backups/service-handle.test.ts` | `apps/api/test/modules/backups/service-handle.test.ts` |
| `apps/api/test/modules/deployments/compose-host-channel-notice.test.ts` | `apps/api/test/modules/deployments/compose-host-channel-notice.test.ts` |
| `apps/api/test/modules/mcp/mcp-body-schemas.test.ts` | `apps/api/test/modules/mcp/mcp-body-schemas.test.ts` |
| `apps/cli/build/stage-cli-payload.ts` | `apps/cli/build/stage-cli-payload.ts` |
| `apps/cli/src/commands/service.ts` | `apps/cli/src/commands/service.ts` |
| `apps/cli/test/unit/service-sync-mapping.test.ts` | `apps/cli/test/unit/service-sync-mapping.test.ts` |
| `apps/cli/test/unit/service-sync-server-env.test.ts` | `apps/cli/test/unit/service-sync-server-env.test.ts` |
| `apps/dashboard/src/app/(dashboard)/settings/_components/AccessEditorModal.tsx` | `apps/dashboard/src/app/(dashboard)/settings/_components/AccessEditorModal.tsx` |
| `docs/stateless-health-preflight.md` | `docs/stateless-health-preflight.md` |
| `packages/adapters/src/backup/executors/docker-list-sources.test.ts` | `packages/adapters/src/backup/executors/docker-list-sources.test.ts` |
| `packages/adapters/src/backup/executors/docker.ts` | `packages/adapters/src/backup/executors/docker.ts` |
| `packages/adapters/src/backup/types.ts` | `packages/adapters/src/backup/types.ts` |
| `packages/adapters/src/runtime/cloud.ts` | `packages/adapters/src/runtime/cloud.ts` |
| `packages/adapters/src/runtime/docker-preflight.test.ts` | `packages/adapters/src/runtime/docker-preflight.test.ts` |
| `packages/adapters/src/runtime/docker-preflight.ts` | `packages/adapters/src/runtime/docker-preflight.ts` |
| `packages/adapters/src/runtime/docker-service-condition.test.ts` | `packages/adapters/src/runtime/docker-service-condition.test.ts` |
| `packages/adapters/src/runtime/docker.ts` | `packages/adapters/src/runtime/docker.ts` |
| `packages/adapters/src/runtime/types.ts` | `packages/adapters/src/runtime/types.ts` |
| `packages/adapters/src/runtime/volume-namespace.test.ts` | `packages/adapters/src/runtime/volume-namespace.test.ts` |
| `packages/adapters/src/runtime/volume-namespace.ts` | `packages/adapters/src/runtime/volume-namespace.ts` |
| `packages/core/src/openship-config/parse.test.ts` | `packages/core/src/openship-config/parse.test.ts` |
| `packages/core/src/openship-config/parse.ts` | `packages/core/src/openship-config/parse.ts` |
| `packages/core/src/types.ts` | `packages/core/src/types.ts` |
