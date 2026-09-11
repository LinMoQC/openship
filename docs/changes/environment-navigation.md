# Environment navigation

A project group can have a draft Production environment and a running PRT environment. Previously the home list selected Production and rendered its single draft badge. Opening the draft returned before the environment switcher was rendered, so reaching PRT required knowing its URL.

This change keeps the grouped project list and adds independent environment links and statuses to both grid and list cards. Draft detail pages render the existing environment switcher. The home response batches environment status reads and projects only navigation/status fields; it filters scoped-token grants before choosing a group's representative and before enriching siblings.

A workload local to a self-hosted control-plane server is not necessarily local to the user's browser. Project info therefore offers a localhost URL only in desktop mode. A recorded verified domain still takes precedence. No domain is guessed from a project name, environment variable, or control-plane hostname; an external reverse proxy without a recorded domain shows the existing unconfigured-domain state. The sidebar labels a public address with its actual environment name.

## Validation

The focused API and dashboard suites passed all 113 tests. API and dashboard TypeScript checks passed. The production dashboard build (`next build --webpack`) passed, and its standalone server started successfully.

The missing Next.js and SWC 16.1.6 packages were downloaded and verified against the SHA512 values in `bun.lock`. No dependency versions or lockfile entries changed.

Browser acceptance used the actual production dashboard and a loopback-only, read-only API fixture; it did not connect to the deployed control plane. Verified at 1440px and 390px:

- Grid and list cards show separate Production draft and PRT running states.
- Clicking PRT opens that environment's overview.
- Production's draft page retains the environment menu; keyboard activation switches back to PRT.
- An unregistered public address shows the existing no-domain state, without a localhost link.
- Narrow list rows give environment links the available width. With the existing sidebar collapsed, both grid and list have no horizontal main-content overflow (306px client width and scroll width at a 390px viewport).

The existing expanded sidebar still consumes most of a phone viewport; mobile checks above use its collapse control. This change does not redesign that shared sidebar or claim full mobile acceptance of unrelated screens.

Focused regression coverage:

- Grid and list cards expose separate links and real states for draft Production and running PRT, without nested anchors.
- The actual draft page still renders its environment switcher.
- Grouped list pagination/scoped visibility retains authorized preview environments.
- Home serializes both states without exposing sibling configuration.
- Remote self-hosted workloads do not advertise browser localhost; recorded public domains still work.

Run from the repository root:

```sh
bunx vitest run --config apps/api/vitest.config.ts apps/api/src/modules/projects/project-list-environments.test.ts apps/api/src/modules/projects/project-home-environments.controller.test.ts apps/api/test/lib/public-endpoints.test.ts
bunx vitest run --config apps/dashboard/vitest.config.ts 'apps/dashboard/src/app/(dashboard)/projects/components/project-card.render.test.tsx' 'apps/dashboard/src/app/(dashboard)/projects/[id]/components/project-draft-navigation.render.test.tsx' apps/dashboard/src/utils/project-status.test.ts apps/dashboard/src/context/project-environments.test.ts
```

This branch contains local source changes only. It does not activate an application environment, modify credentials, register routes, or replace the running OpenShip control plane. Live server integration remains a separate release step.
