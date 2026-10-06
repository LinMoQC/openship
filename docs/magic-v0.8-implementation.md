# Magic OpenShip v0.8 implementation and release evidence

Upstream baseline: `234d8a9d0bd571aff3fe3ce73a8408f226dcb4a0` (v0.8.0). Do not follow upstream main during this adaptation.

Implementation branches: `feat/openship-v0.8-gitops` and GitOps `feat/openship-v0.8-controller`. Runtime identity is derived from a clean committed tree as `0.8.0-magic.<commit12>`; CLI/API, Dashboard, SDK, contract and SHA256 checks must refer to that exact tree.

## Scope and deployment boundary

Upgrade the control platform and validate Admin, Web, then Core PRT. Business production applications, public ingress, certificates, ports, networks and volumes stay unchanged. Production readiness is presented as checks; production promotion is outside this rollout. The authorized control-platform maintenance window is 15–30 minutes, with deployment frozen and existing business containers continuing to run.

## Implemented architecture

- Shared Platform operations own authorization, admission, frozen plans, workflow identity, acceptance and recovery; HTTP, native/remote SDK, CLI and MCP delegate to them
- Explicit project bindings identify each environment, stack, repository, manifest, workflow and controller Token ID; repository names are never used to guess management mode
- Incremental migration `0151_gitops_releases.sql` creates ReleaseBinding, ReleasePlan, ReleaseRun and ServiceCutoverJournal records; credentials remain in existing encrypted stores
- Plans expire after ten minutes; submission revalidates the target, current deployment, environment hash, authorization and blockers; atomic admission consumes one plan and permits one active run per project
- Workflow dispatch uses the current user's GitHub OAuth identity; a timeout becomes submission-unknown and reconciles the existing run without automatic retransmission
- Controller registration verifies authenticated Token ID, repository, workflow/ref/SHA, actor, Run, manifest and exact services; controller registration is not exposed through MCP
- Bound projects reject ordinary Update, Redeploy, Rollback, source upload, webhook and direct deploy mutations without the registered execution context
- Acceptance requires the immutable GitOps receipt, active deployment, actual image digests/topology/configuration and external probes; GitHub success alone does not mean accepted
- State compares the stack manifest and actual containers; configuration-only changes, unknown/stale state, drift, eligible target and blockers have separate UI states
- Five-minute background detection and explicit fresh inspection coexist; acceptance invalidates then refreshes the matching cache; conditional SQL writes prevent old inspection from overwriting newer state
- Stateless candidate opt-in uses isolated candidate DNS/ports and immutable local image IDs, durable journal recovery and retained incumbents; Core completion jobs and stateful services do not inherit parallel candidate or database rollback behavior
- Legacy scoped failure/reject fixes preserve the incumbent and exclusive scope, including the public build-access/source-upload contract
- Maintenance freezes shared deployment admission and existing GitOps workflows, drains every project environment, saves a consistent matching database/key/runtime backup and refuses database downgrade after any ambiguous unfreeze

## Compatibility audit

The original fourteen custom commits and all forty-two changed paths were compared with the fixed v0.8 tree. The current live runtime additionally contains seven later commits; those were audited too. The original worktree remains preserved.

| Original commit | Behavior and v0.8 destination | Regression evidence |
| --- | --- | --- |
| `0293c43a` | Dependency conditions, completed tasks and namespace dependencies in shared Compose parser, engine and Docker adapter | compose-parser, docker-service-condition, exact-service-targets, real Core migration scope |
| `e093b093` | Fixed Magic runtime packaging in magic-runtime workflow and CLI payload staging | runtime verifier, installed SDK and shipped offline Docker drill |
| `293bba8f` | External network identity in volume/network resolution and Docker adapter | volume-namespace, compose host-channel and actual release topology |
| `b97b2189` | Nested collection writes require the parent project grant; use v0.8 shared authorization | permission-nested-list-parent, service/schema and SDK/HTTP parity |
| `8c6aeaf4` | Private Compose stacks do not initialize Edge | compose-host-channel-notice and real Core isolated network |
| `e451943e` | Private stacks do not query Edge inventory | compose-host-channel-notice |
| `76ce237b` | Targeted MCP deploy fields live in shared contracts and Platform | mcp-body-schemas, native-sdk-parity, exact-service-targets |
| `7fc26cc3` | Magic asset tag independent of upstream update tag | clean-source identity and paired archive verification |
| `7589ac21` | Scoped project tokens retain their own environment and nested access | project-environment-access, token SDK parity and controller capability isolation |
| `e5990189` | Environment grants retain permission level | project-environment-create/access and AccessEditorModal tests |
| `15b28535` | Matching Dashboard packaged with the CLI/API | paired magic-runtime.json, SHA256 and standalone server checks |
| `023c941b` | Dashboard archive verified without a pipe swallowing failures | magic-runtime workflow verification |
| `cbbabdab` | --server-env read on the server; expected services and scope checked | service-sync-server-env, host-config-inspection, GitOps environment checks |
| `4c945f1d` | Candidate health gate retains incumbent | adapter preflight, real stateless and durable cutover suites |

| Additional live commit | Disposition |
| --- | --- |
| `141bb86c` | Duplicate squash of candidate-health behavior; covered by durable replacement |
| `8033b335` | Use v0.8 environment navigation, with full application/environment labels on release surfaces |
| `de9ee01a` | Use v0.8 explicit project ID/runtime and variable-set guard; GitOps always supplies the bound environment, with production-target mismatch rejected |
| `284ea57c` | v0.8 shared cancellation authorizes deployment write through its parent project; inherited by project write credentials |
| `a0bab55a` | Ported result status helper: carried containers and successful completion tasks cannot publish a failed live-service release |
| `99d9f1ae` | Ported scoped reject planning; no redundant redeploy of the already-active predecessor; stale or empty exclusive scope fails closed |
| `584fa889` | Reuse v0.8 retained-artifact keep sets protecting carried active containers/images, plus pending-journal retention veto |

The path-by-path inventory is in [magic-v0.8-compatibility-paths.md](magic-v0.8-compatibility-paths.md).

## Recorded local evidence (2026-10-07)

These are actual local executions, distinct from GitHub CI or live rollout evidence:

| Proof | Result |
| --- | --- |
| Final API full regression | 7,334 tests / 594 files passed |
| Shared Platform | 227 tests / 30 files passed |
| Dashboard | 2,227 tests / 210 files passed; production build passed |
| SDK | 182 tests passed; final source scope subset 19 passed |
| GitOps controller/maintenance/inventory | 81 tests passed |
| Scoped status/reject/retention/build regressions | 140 tests passed |
| Final public scope/HTTP/MCP subset | 113 tests passed; final exclusive-scope/build/server-sync subset 116 passed |
| Installed distribution on Node 24 | ESM, CommonJS, NodeNext declarations, native persistent deployment, tenant isolation, revocation, teardown and CLI passed |
| Real Docker stateless preflight | Actual unhealthy/pull/activation/final HTTP failure scenarios passed |
| Real Docker durable cutover | 22 scenarios passed, including three literal SIGKILL/restart cases and fresh durable PGlite reopen |
| Real isolated Core failed SQL migration | Failed task blocks API; old API responds; database/container/volume/active deployment remain unchanged; transaction schema change rolled back |
| Real PostgreSQL platform upgrade | Old schema chain upgraded, encrypted configuration checked, wrong key rejected, dump/restore verified |
| Shipped offline tool in real Docker | Synthetic old PGlite copy upgraded to all 152 migrations; encrypted data/restore and unchanged original verified |
| Browser release workspace | Desktop, 390px narrow dark theme, unknown/blocked/retry, exact production confirmation and keyboard activation verified against actual UI fixtures |

A macOS sleep interrupted one literal-kill run. The unchanged suite subsequently passed with a temporary test-only wake assertion; timeouts were not loosened. Fixture UI and synthetic database results do not establish live GitHub identity, actual server migration or PRT acceptance.

## Mandatory publication and rollout gates

- Complete the committed-tree CI gate, including upstream tests, installed SDK on Node 22/24, real Docker fast/heavy, scaling and ACME jobs
- Publish complete matching CLI/API/Dashboard artifacts with source, upstream, contract and SHA256 metadata; run the shipped offline Docker verifier on the extracted artifact before publication
- Pin that published identity in GitOps and preserve controller/workflow authorization and exact scope
- Stage the immutable package without touching the running executable; simultaneous staging is locked
- Freeze/drain and capture a consistent live platform database snapshot and original key, resume the old platform, then verify that private live copy with the shipped offline Docker tool
- Enter the actual maintenance window only after that exact-target/key/live-copy drill passes
- Verify login, permissions, decryption, API/Dashboard capabilities and unchanged business containers before unfreeze
- On pre-unfreeze failure restore the matching old runtime, database, key and systemd configuration; retain failed migrated state privately for diagnosis
- Bind all six validated environments without inventing historical acceptance receipts
- Validate Admin PRT → Web PRT → Core PRT; unchanged targets use verified no-op
- Observe at least 24 hours after actual rollout; show missing production activation, migration rehearsal, backup, environment and topology evidence separately

No live upgrade, runtime publication, six-project binding or PRT acceptance is implied by local code tests. Backups, database contents, live environment values and encryption keys must stay outside the repository, release packages and public CI artifacts.
