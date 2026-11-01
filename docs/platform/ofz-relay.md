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
`CheckConnectorAgent`, the dormant opt-in flag and their native definitions are removed. Guest API protocol 9 rejects
the previous installation contract. There is no fallback or dual implementation.

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

- On `admin.proompteng.ai`, `GET /api/platform/workspaces` lists administered workspaces. The selected workspace's
  resource inventory, members, clients and activity use `/api/platform/workspaces/<workspace-id>` and `/activity`.
  Ofz checks native workspace administration on every request; global platform administration is no bypass.
- On the admin host, `GET /api/platform/policies` returns the policy version/catalog, or reads assignments with an
  explicit `workspaceId`, resource and recipient.
- `POST /api/platform/policies` writes declared relationships through Ofz with current administrator authority and MFA.
- `GET /api/platform/connectors` returns the shared Relay operations and enrolled target identities.
- Settings → Connections manages saved consent separately from expiring credentials. `GET /api/tengri/connections`
  lists the signed-in issuer's connections for an accessible workspace. No credential appears in that response.
- `POST /api/tengri/connections` saves an explicit scope or reconciles existing enabled consent. The server derives
  actions, immutable target identities and current runtime binding from the registered catalog and controller. It
  activates a new credential only after the guest acknowledges its exact installation. Renewal cannot enable revoked
  consent or substitute a recreated namespace with the same name.
  Connecting uses existing approved permissions. A missing permission requires a separate workspace administrator
  decision in the portal; product consent and credential renewal cannot write relationships.
  The consent operation binds the human, client, workspace and exact scope. A renewed session or runtime does not
  change that identity, but replay rechecks its current authority before returning the original receipt.
  Saving consent uses the current verified session. Administrative permission changes in the portal require fresh
  passkey verification. Renewal and revocation require a current MFA session; they
  do not require another passkey ceremony every five minutes. Renewal rechecks the saved scope and current native
  permissions, and cannot widen consent.
  Connections shows a service list with current status. Connect or Manage opens one editor for resources and a
  readable permission summary; individual tool choices sit under Customize access. Returning to the list preserves
  selections, and success returns to the list with focus on Manage. This follows
  [progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) and
  [preserving answers within a journey](https://design-system.service.gov.uk/patterns/question-pages/).
  The Tengri client reconciles on resume and before starting or continuing a turn. Periodic renewal runs only while
  a turn is active. Credentials remain bounded by both the session expiry and its idle deadline.
- `DELETE /api/tengri/connections` revokes saved consent and all child credentials before guest cleanup. Cleanup can
  remain pending while the guest is unavailable; revocation is already authoritative. Guest generation checks reject
  delayed installs and prevent an old cleanup from removing a newer connection.
- The admin portal's Integrations tab assigns or revokes workspace-scoped relationships for members, people and
  enrolled clients. It uses named resources and operations. SPIFFE identities, resource IDs and policy versions remain
  transport details. The product gateway has no `platform.administration` role.
- `/api/platform/relay/agent` forwards the guest's proof-bound exact request body to Relay. Its strict envelope requires
  `kind: "execute"` or `kind: "lookup"` and a canonical base64 body. Lookup signs a distinct body containing the original
  execution bytes. The proxy cannot select an identity or client on the guest's behalf.

The standalone `relay-client` MCP bridge uses the same operation catalog and execution body with its own registered
SPIFFE workload identity. It does not route through the Tengri BFF or create a workspace.

Both MCP clients expose operation and receipt IDs in `_meta.relay`. After a lost response they perform one fresh
authorized status lookup and retain an error result because the original provider response is unavailable. A recorded
`started` state remains unconfirmed. Neither client resends Execute to recover a transport failure.

Tengri owns guest installation and its session/workspace integration. The former shared catalog GET under
`/api/tengri/connectors` is removed. Web and guest images must roll together for the new required proxy envelope.

See [Ofz service/policy onboarding](../../services/ofz/platform/README.md),
[Relay execution](../../services/relay/README.md) and [OpenCode integration](../../services/opencode/README.md).
