# Ofz service and policy onboarding

Ofz is the platform authorization authority. It uses SpiceDB's Zanzibar model: resource relationships, computed
permissions, fully consistent permission checks, expiring delegation relationships and native revision tokens.
SpiceDB is the implementation; no separate Zanzibar server is involved.

`services.json` enrolls service identities and roles. `policies.json` declares resource kinds, actions, native types,
permissions and writable relationships. `schema.zed` supplies the corresponding native definitions. New application
policies use these definitions without adding a Tengri action enum or a branch in the platform evaluator.

An action declares `grantRelation` for direct assignments and `workspaceGrantRelation` for approved workspace-wide
access. Qualification checks both against the installed native schema. Connecting records consent to existing
permissions; it never assigns relationships. Saving and reconnecting an approved scope reuse the current verified
session. Policy changes require a workspace administrator and fresh MFA through the independent admin gateway.

Members can request named resource capabilities from their enrolled client. Requests are limited to the workspace's
registered resource ceiling and writable human grants. Submitting or cancelling a request assigns no permissions.
The admin portal lists pending requests for the selected workspace. Approval checks current membership and client
enrollment, assigns only missing permissions, and requires fresh MFA when it adds relationships. Decline and cancellation
do not require step-up. Request state, relationship changes and audit receipts use the existing durable command journal.
Retries retain the original operation ID across sign-in and return the original receipt. Replaying an approval after
revocation does not restore access. Tengri refreshes current eligibility when returning from the admin portal.

The access-request migration is `0008_access_requests.sql`, platform ledger version 7. Complete pending commands before
upgrading Ofz; its migration hook runs before the coordinated gateway rollout. Requests retain their administrative
workspace and requesting client. The queue is bounded to eight pending requests per person and 128 per workspace.

`workspaces` in the service registry assign each external resource to one administrative workspace. SpiceDB owns
workspace membership, administrators and enrolled clients. Resource authorization checks both the operation permission
and current workspace use in one fully consistent bulk request. A global platform administrator cannot bypass a
workspace's roles. Initial onboarding imports the existing platform members and registered clients for the initial
workspace, once; enrollment markers prevent subsequent onboarding from restoring revoked access. Existing connections
and delegations receive their immutable workspace ID during onboarding. Their scope cannot move to another workspace.

The checked package is the approval boundary. Invalid definitions, duplicate identities/actions, unknown fields,
wildcards and unknown policy actions fail closed. `OFZ_SERVICES_FILE`, `OFZ_POLICY_CATALOG_FILE`,
`OFZ_POLICY_SCHEMA_FILE` and `OFZ_POLICY_SCHEMA_SHA256_FILE` can select reviewed mounted definitions. All Ofz replicas
and the onboarding job must receive the same package; changes require restarting the process.

## Add a service

1. Add its stable service ID and exact SPIFFE identities to `services.json`.
2. Give ordinary API consumers `platform.client`; add `relay.client` when the service uses connectors.
3. Register the actual Kubernetes service account/container with SPIRE and add its explicit network paths.
4. Onboard the reviewed Ofz package, then assign the required resource relationships through Ofz.

Registration establishes identity, without granting resource permissions. Relay reads the approved client roster
from Ofz and refreshes it; it has no separate client list. Research OpenCode is deliberately unenrolled.

Only trusted browser gateways get `session_gateway` configuration with an exact `origin` and `oidc_client_id`, and, where appropriate,
`platform.administration`. Delegating gateways also need a registered HTTPS `proof_audience`. A client can require an
execution binding through `binding`: service, resource kind and issuer permission. Tengri binds its workspace UID and
current runtime epoch; independent OpenCode uses workload authority and needs no artificial workspace.

## Add or change policy

1. Define a namespaced resource kind and actions in `policies.json`.
2. Add the native definition and its computed permissions to `schema.zed`. Declare only the relations clients may
   manage; the API does not expose arbitrary native writes.
3. Run `bash services/ofz/qualify-platform.sh --write` and review the resulting `schema.sha256` change.
4. Run the policy and platform fixtures. Release the package through the normal image/GitOps gates.

Qualification uses the pinned disposable SpiceDB and hashes its canonical schema readback. It also checks every
catalog permission exists and denies an unassigned subject. A source-text hash is insufficient because SpiceDB
formats its stored schema. The normal check command never rewrites the qualified digest.

`ofz onboard-policies` requires the `ofz_migrator` PostgreSQL owner in `ofz_control`. It serializes with policy
commands, records the approved previous/desired hashes and package identity before changing native policy, installs
that exact schema, and commits the native command/version marker, SQL version, immutable audit and original receipt.
Interrupted retries recover the same intent. A different package or unexpected installed schema is rejected. Pending
onboarding blocks platform authorization and new Tengri policy commands until owner recovery; no retry un-fences the
platform. Completed bootstrap receipts and their original hashes remain unchanged.

The hard cutover revokes retired Tengri namespace/connector grants, deletes their native relationships and removes
their definitions and broker roles. Workspace grants, human identity, membership, workspace ownership, sessions and
audit history are retained. The old policy is present only as a migration-test input under `tests/fixtures`.

## Assign access

`ReadPolicyRelationships` reads the fully consistent direct relationships for one declared resource and recipient.
The admin gateway exposes it through `GET /api/platform/policies?workspaceId=...&kind=...&id=...&subjectKind=...&subjectId=...`.
It requires a registered `platform.administration` service with a configured session gateway, its exact allowed origin,
an active human session and native `manage` permission on the exact `workspaceId`. Reads are audited and recheck current
authority after the receipt commits. They do not require fresh MFA. `GetPlatformConfiguration` remains metadata-only;
ordinary registered clients cannot inspect permission assignments through that RPC.
The Settings editor loads this snapshot before enabling changes and submits only the added/removed relationships
against its policy version. An unconfirmed write retains the exact request and operation ID until retried.

An authenticated workspace administrator with fresh passkey verification uses `POST /api/platform/policies` on the admin host. The Ofz RPC is
`WritePolicyRelationships`. It requires the expected policy version, exact resource, declared relation and subject,
and an audit reason. Policy commands use a durable intent and native version marker; retries return the original
receipt. Delegation credentials are delivered only once and never persisted in receipts.

For example, grant standalone OpenCode pod-status access to one enrolled namespace:

```js
const configuration = await fetch('/api/platform/policies').then((response) => response.json())
const response = await fetch('/api/platform/policies', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    operationId: crypto.randomUUID(),
    workspaceId: '<administrative-workspace-uuid>',
    expectedPolicyVersion: configuration.policyVersion,
    relationships: [
      {
        resource: { kind: 'kubernetes.namespace', id: 'galactic/<namespace-uid>' },
        relation: 'status_reader',
        subjectKind: 'workload',
        subjectId: 'spiffe://proompteng.ai/ns/opencode/sa/opencode',
        enabled: true,
      },
    ],
    reason: 'Allow OpenCode to inspect this namespace',
  }),
})
```

Use the registered target's actual resource ID from `GET /api/platform/connectors`; do not use a namespace name as policy
identity. `log_reader` and `event_reader` are separate assignments. Setting `enabled: false` revokes the relationship.
Human subjects use their verified canonical Ofz human ID. Platform administration grants no workspace content access.
The normal Connections flow derives the signed-in human identity on the server; it requires no identity or policy IDs.

Each platform authorization checks the current registered action, resource type, actor, native relationships,
recovery generation, fence and archive health. Delegated access intersects the grant with the issuer's current
permission and required execution binding. An allowed decision follows a durable audit and fresh authority checks;
a previous receipt can identify an invocation but cannot replace a current permission check.

`GetPlatformExecution` is restricted to registered executors. It requires fresh authorization with a lookup-body
hash distinct from the original execution hash. The immutable authorization receipt binds the original client,
action, resources and owner. Delegated receipts resolve ownership through the recorded issuer, so client-selected
agent IDs cannot reveal another issuer's execution. Lookup checks authority again before returning receipt metadata
and digests. It returns no result body and does not change execution state.
