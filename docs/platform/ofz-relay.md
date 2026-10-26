# Ofz and Relay platform migration

Status: implemented in source and exercised in isolated integration fixtures. Production activation and live cluster
acceptance remain separate release gates.

Ofz owns platform authorization and policy onboarding through SpiceDB. Relay owns connector execution.
Tengri and standalone OpenCode are clients. Kubernetes is the first connector.

## Delivery predicate

The migration is complete when both clients use the same Relay operations and Ofz policy contract, a second service
can enroll through a reviewed definition without edits to the authorization evaluator or execution dispatcher,
and integration tests prove allowed access, resource isolation, revocation, expiry, replay rejection and failure
accounting. Required CI and review must pass on the merged revision. Production activation is a separate boundary.

## Implementation sequence

1. Replace fixed caller enrollment with validated service definitions. Separate the Tengri domain interface from
   the platform authorization interface and migrate existing callers. Remove the old public service endpoint.
2. Add service-scoped policy definitions, checked schema onboarding, relationship management and audited decisions.
   Preserve existing native relationships and the original bootstrap journal.
3. Implement Relay's common execution contract and the Kubernetes adapter. Normalize targets once, authorize those
   targets, then execute the same request. Keep cluster credentials inside the executor.
4. Provide typed platform clients and the agent tool bridge. Integrate the Tengri BFF/guest and standalone OpenCode
   without manufacturing a Tengri workspace for OpenCode. Keep research isolated.
5. Update deployment inputs, generated contracts, inventory, documentation and required validation. Deliver one
   active contract through reviewed merge; retain no compatibility endpoint or alternate implementation.

## Ownership

Service definitions enroll exact SPIFFE identities and their permitted roles. Attestation alone grants no resource
access. Policy definitions name resources, actions and native SpiceDB permissions. New native definitions are
installed by the reviewed Ofz onboarding command under the migration identity, with an expected installed schema
hash. Ordinary clients cannot replace the global native schema or obtain its credential.

The platform interface accepts registered actions and resource references. Human authority, delegated authority
and workload authority are distinct. Delegations bind their issuer, client, subject, allowed resources and actions,
expiry, recovery generation and any execution binding. Every request checks current authority and commits its
audit before returning an allowed decision.

Tengri retains its domain lifecycle commands, session verification, workspace ownership and runtime fences in its
domain interface. These are application rules rather than mandatory fields for every platform client.

Relay adapters own protocol semantics and canonical target extraction. The Kubernetes adapter uses a registered
cluster endpoint and CA, a rotating projected service-account credential and explicit RBAC. The first operations
are workload status, bounded pod logs and events. Secrets, raw URLs, arbitrary commands and unregistered operations
are outside those operations. A new effectful operation requires its own reviewed action and execution contract.

## Hard cutover

The public `AuthorizationService` endpoint is removed. Existing Tengri consumers use `TengriAuthorizationService`;
platform clients use `PlatformAuthorizationService` and `RelayService`. Namespace/connector enum actions and commands,
`CheckConnectorAgent`, the dormant opt-in flag and their native definitions are removed. Guest API protocol 10 rejects
the previous installation and HTTP envelope contracts. There is no fallback or dual implementation.

The SQL migration is checksum-bound and leaves the original migration and bootstrap receipts unchanged. Policy
onboarding records a separate approved intent, revokes retired grants and removes retired native relationships before
installing the qualified schema. An interrupted native write resumes its original journal entry. Current package,
current authority and durable audit are required before a platform decision can allow access.

Release through the normal Ofz/Tengri/Nanoagent/Proompteng image cohort and Kargo stages. Drain old policy writers and
finish any old pending commands before cutover. Run the control migration, roll the cohort, complete the existing
bootstrap/activation prerequisites, then run the Ofz post-sync policy onboarding hook. SPIRE registrations and network
paths precede Relay and OpenCode acceptance. Relay and OpenCode use their own immutable image publication and Kargo
promotion paths; no image aliases or direct-cluster deployment bypasses are part of this migration.

Native namespace grants are explicit policy onboarding, never defaults from service registration. With the selected
images deployed, verify an allowed operation from each client, a denied namespace, issuer/workload revocation, guest
runtime change, provider RBAC denial and the corresponding immutable receipts. Infrastructure readiness alone does
not prove connector execution. Production rollout and this acceptance remain outside the source-merge claim.

## Operator interfaces

- `GET /api/platform/policies` returns the current policy version and action/resource catalog.
- `POST /api/platform/policies` writes declared relationships through Ofz with current administrator authority and MFA.
- `GET /api/platform/connectors` returns the shared Relay operations and enrolled target identities.
- `POST /api/tengri/connectors` installs a selected connector/operation/target delegation into the current guest and
  activates it only after acknowledgement. It accepts a stable operation ID, agent ID, connector ID, operation names,
  target names and expiry; the server derives actions, resources and the current execution binding.
- `DELETE /api/tengri/connectors` revokes the Ofz delegation before removing the guest tool configuration.
- `/api/platform/relay/agent` forwards the guest's proof-bound exact request body to Relay. Its strict envelope requires
  `kind: "execute"` or `kind: "lookup"` and a canonical base64 body. Lookup signs a distinct body containing the original
  execution bytes. The proxy cannot select an identity or client on the guest's behalf.

The standalone `relay-client` MCP bridge uses the same operation catalog and execution body with its own registered
SPIFFE workload identity. It does not route through the Tengri BFF or create a workspace.

Both MCP clients expose operation and receipt IDs in `_meta.relay`. After a lost response they perform one fresh
authorized status lookup and retain an error result because the original provider response is unavailable. A recorded
`started` state remains unconfirmed. Neither client resends Execute to recover a transport failure.

Web RPC, SPIFFE and Ofz clients live in `apps/landing/src/lib/platform`; generated contracts live in `src/lib/generated`.
Tengri owns guest installation and its session/workspace integration. The former shared catalog GET under
`/api/tengri/connectors` is removed. Web and guest images must roll together for the new required proxy envelope.

See [Ofz service/policy onboarding](../../services/ofz/platform/README.md),
[Relay execution](../../services/relay/README.md) and [OpenCode integration](../../services/opencode/README.md).
