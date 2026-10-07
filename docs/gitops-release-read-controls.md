# GitOps release reads and legacy host workspaces

Version checks read mutable branch heads on every fresh inspection. Directory
listings are then addressed by that exact commit, and event and receipt bodies
by their verified Git blob SHA. Immutable responses use a bounded 16 MiB / 2,000
entry cache for 30 minutes. The cache and in-flight reads are scoped to the
OpenShip organization, user, source and controller token, and repository.
The blob content hash is verified before reuse. This does not reuse a mutable
branch response or turn a cached receipt into a production authorization.

Concurrent status inspections of the same authorized principal and binding
share one request. Failed inspections retain the last successful evidence as
stale, record a separate attempt time, and persist a retry deadline. Background
reads back off for at least one minute; a GitHub rate-limit deadline also
applies to explicit refreshes. The HTTP primitive observes `x-ratelimit-reset`
and `Retry-After` before sending another request with the same credential and
resource bucket. It never retries a workflow mutation. A new credential does
not create a new personal GitHub quota.

An older instance may already own its local projects in a workspace whose ID
is not `org_<founderId>`. Set `OPENSHIP_HOST_ORGANIZATION_ID` in the control
platform's operator-managed service environment to that existing workspace ID.
The configured organization must exist and its **owner** must be the same
founding administrator. The ownership proof is rechecked, so removing or
demoting that owner denies local host access immediately. Other organizations
cannot use this host through a loopback server or by changing project variables.
Without this setting, the upstream founding-personal-workspace policy remains.

Configure and verify this in an isolated copy of the existing platform database
before activating a paired CLI/API and Dashboard release. Keep the original
workspace and project IDs, controller token scopes, business containers and
database history. This setting does not enable production deployment.
