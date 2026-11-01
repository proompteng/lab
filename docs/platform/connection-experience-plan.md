# Platform connections and workspace administration

Status: implementation in progress. The gateway, workspace policy and portal changes are implemented and locally qualified; deployment and the remaining connector/client acceptance work are pending.

Research date: 2026-11-01, America/Los_Angeles. Source findings were checked against `origin/main` at
`64a848f4b91e73070f836f5a36b4ae2bf04f79e1`. Source and runtime evidence take precedence over this proposal.

## Decision

Tengri should let people connect and use approved integrations. Workspace administration belongs in a separate
portal, proposed at `admin.proompteng.ai`, with an explicit workspace selector and authorization on every request.
Ofz remains the authorization authority and Relay remains the executor. Both clients use the same connection
contracts; standalone OpenCode does not acquire a dependency on a Tengri runtime.

The portal is an additional frontend for the existing platform services. It does not need another authorization
engine, connector framework, or copy of the credential lifecycle.

## What the research supports

These are documented product patterns, not comparative usability or conversion measurements for our product.
The recommendations below combine those patterns with the current source and the user's reported friction.

| Source                                                                                                              | Observed pattern                                                                                                              | Recommendation for this platform                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Plaid Link](https://plaid.com/docs/link/)                                                                          | A temporary session opens a focused account-linking experience; durable access is established on the backend.                 | Give Tengri one server-created connection flow, with provider setup details outside the user's task.                                            |
| [Plaid update mode](https://plaid.com/docs/link/update-mode/)                                                       | An existing account can repair authorization or add consent without being treated as a new installation.                      | Reconnect the existing connection and preserve its identity, selections, and consumers.                                                         |
| [Plaid conversion guidance](https://plaid.com/docs/link/best-practices/)                                            | Explain the purpose before opening the flow and prepare the UI before the user opens it.                                      | Use one concise explanation of access, then open a prepared flow. Measure loading time separately from provider interaction.                    |
| [OpenAI plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)                             | Availability, member roles, account access, allowed actions, and confirmation settings are separate controls.                 | Publish an approved catalog to users; keep the corresponding administration in the portal.                                                      |
| [OpenAI workspace connections](https://learn.chatgpt.com/docs/enterprise/shared-connections)                        | Administrators maintain company accounts and separately control discovery, use, and management.                               | Distinguish personal connections from workspace-managed connections and show which account an agent will use.                                   |
| [WorkOS Admin Portal](https://workos.com/docs/admin-portal)                                                         | A dedicated administrative session is restricted to one organization, with protected entry into the portal.                   | Bind every portal operation to an authorized workspace. A subdomain and workspace picker alone are insufficient.                                |
| [Slack app controls](https://docs.slack.dev/concepts/security/)                                                     | Administrators can preapprove apps; other installations can follow a request-and-approval path.                               | An approved integration should connect directly. A restricted integration should offer a clear access request instead of an administrator form. |
| [Nango Auth](https://nango.dev/docs/guides/auth/auth-guide)                                                         | A server-created connection session drives a reusable auth UI; credentials are maintained server-side, with a reconnect flow. | Reuse one connection lifecycle across HTTP and MCP and keep the user/account association authoritative on our backend.                          |
| [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)                   | HTTP authorization includes discovery, PKCE, issuer/resource checks, and provider-dependent refresh behavior.                 | Put upstream authorization in shared platform code, separate from Ofz permissions and client UI.                                                |
| [MCP security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) | Proxying introduces token-audience, redirect, discovery, and process-execution concerns.                                      | Validate destinations and keep internal platform authority distinct from upstream credentials.                                                  |

The useful pattern is a small member experience backed by explicit administrative decisions. Copying a modal's
appearance without changing those decisions would preserve the current confusion.

## Current implementation and the gaps

- [SettingsApp](../../apps/landing/src/components/tengri/settings-app.tsx) renders both Connections and AccessPanel.
  The latter exposes Workspace, Platform, Audit, and Service access in product settings.
- [ConnectionsPanel](../../apps/landing/src/components/tengri/connections-panel.tsx) combines catalog discovery,
  target selection, consent, credential installation, and recovery. Its selections are tied to a human and current
  Tengri workspace.
- [Connection permission changes](../../services/ofz/src/platform/connections.rs) can assign selected resource
  relationships when Connect has platform administration authority. This explains part of the passkey and policy
  friction. A member's Connect action should instead operate inside preapproved workspace policy.
- [Policy mutation authorization](../../services/ofz/src/platform/mutations.rs) checks the global
  `platform:lab#manage_targets` permission. The existing [schema](../../services/ofz/schema.zed) has runtime workspace
  ownership and collaborators, but no independent administrative workspace containing shared connector installations.
  A customer workspace administrator must not need global platform administration.
- [Browser sessions](../../apps/landing/src/lib/platform/auth.ts) use a host-only cookie and the Tengri authorization
  interface. [Ofz session handling](../../services/ofz/src/sessions.rs) still identifies the existing BFF explicitly.
  A separately hosted admin gateway needs its own enrolled identity, origin, and platform session contract.
- [Relay's adapter interface](../../services/relay/src/connector.rs) is reusable, but its
  [production configuration](../../services/relay/src/config.rs) currently constructs Kubernetes adapters only.
  The existing [MCP bridge](../../services/relay/src/bin/relay-client.rs) exposes Relay to clients. It is not an
  upstream MCP client or an OAuth provider-connection manager.
- [The executor](../../services/relay/src/service.rs) currently rejects effectful operations. That remains a real
  implementation limit, independent of the UI migration.

## Member experience in Tengri

The entry points are Settings → Connections and a compact Connect action when a task needs an unavailable integration.
Both open the same flow. Neither opens administrative policy tabs.

The list shows a recognizable integration name, the connected account or workspace, a short access description,
and one relevant action. Users should see names such as “Galactic” and “Tengri namespace,” rather than namespace UIDs,
SPIFFE identities, native relationships, or schema versions.

| Situation                            | Member-facing action   | Behavior                                                                                                  |
| ------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Approved, not connected              | Connect                | Start the connection flow using the workspace's approved access.                                          |
| Available workspace-managed account  | Use connection         | Select it without authenticating the shared account again.                                                |
| Available personal OAuth integration | Connect account        | Authenticate with the provider, choose meaningful resources if needed, then return to the same task.      |
| Connected                            | Manage                 | Show account, readable access summary, and Disconnect.                                                    |
| Provider credentials need repair     | Reconnect              | Repair the existing connection; preserve its ID and permitted consumers.                                  |
| Approval required                    | Request access         | Show what is requested and its pending/approved/declined status. Do not present an admin policy editor.   |
| Temporarily unavailable              | Retry when appropriate | Preserve the account and access selections; distinguish a provider outage from missing permission.        |
| Access was removed                   | Access removed         | Explain the change and offer a request path where allowed. Reconnect must not restore revoked permission. |

For the current Kubernetes integration, the target experience is:

1. A workspace admin has already approved Galactic and the permitted namespace/read operations.
2. The member presses Connect, with a short summary of that access.
3. The backend records consent and installs the bounded credential in the current agent.
4. After guest acknowledgement and an authorized verification, the UI shows Connected and the current agent can use it.

There is no provider login for an administrator-configured workload credential. Connecting does not also assign new
resource relationships to the person. Where more than one meaningful account or resource choice exists, show that
choice; otherwise derive it from policy and existing context.

Use a compact desktop dialog and a full-height mobile sheet, built from the existing design components. Keep one
primary action, a short capability explanation, accessible focus handling, preserved Back behavior, and a reliable
provider redirect return. Do not nest the product in another desktop window on a phone. Keep input text at a size
that does not trigger focus zoom, preserve chat scroll/composer state, and test the software keyboard.

Provider authorization is expected when initially connecting an account or requesting additional upstream scopes.
Routine token refresh and unchanged platform consent should not repeatedly invoke a passkey ceremony. A failed
provider token and a missing Ofz permission must produce different recovery actions.

## Workspace admin portal

Proposed URL structure: `admin.proompteng.ai/workspaces/<workspace-id>/...`. The workspace name and switcher remain
visible. The selected workspace is context, not proof of authority; Ofz verifies membership and administrative
permission for the exact target on every read and mutation.

| Area            | Responsibilities                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Overview        | Connection health, access requests, and changes needing attention.                                                                        |
| Integrations    | Enable approved connectors, configure installations and provider profiles, choose allowed resources/actions, and handle new tool changes. |
| Connections     | Maintain workspace-owned accounts, connection owners, approved consumers, reconnect, and revoke.                                          |
| People & access | Assign workspace owner/admin/member access and specific connection use/manage permissions.                                                |
| Policies        | Edit readable access rules and presets, with affected users/resources and a change summary before saving.                                 |
| Requests        | Approve or decline access requests with a reason, then notify through the existing authorized notification path.                          |
| Activity        | Search connection, policy, and execution activity. Keep receipt IDs and technical details in a detail view.                               |
| Security        | Workspace authentication requirements and service identities. Sensitive changes receive contextual verification.                          |

Start with the controls needed for current connections and policies. Do not build a generic dashboard collection,
a new policy language, or arbitrary native SpiceDB schema editing. Common rules should read like “Workspace members
may read pod status and logs in Tengri.” Advanced operation choices are progressively disclosed.

Workspace admins administer only their approved installations and resource ceiling. Global connector code,
cluster credentials, trusted destinations, native schema onboarding, and platform-wide administration remain
operator controls. Show operator functionality only under separately authorized platform context in the same
portal; it does not require another customer-facing portal.

Personal account settings and passkey management remain in the product. A small “Workspace administration” link
may appear for authorized admins and opens the portal. It does not embed administrative forms back into Tengri.

## Administrative scope and authority

Introduce an administrative platform workspace distinct from the existing `tengri.workspace` execution resource.
The former contains members, approved installations, connection access, and service principals. The latter retains
its current ownership, home, runtime epoch, and guest authority. A platform workspace can contain Tengri and standalone
OpenCode consumers without manufacturing a Tengri runtime for OpenCode.

Keep the initial relationship model small: workspace owner, admin, and member; connection use and manage;
installation availability; approved operation/resource scope. Retain global operator authority separately.
Connection and installation records carry an immutable administrative workspace ID. Policy writes validate the
workspace of every target and recipient server-side. An admin cannot authorize a namespace or connection that belongs
to another workspace or exceeds the operator-approved resource ceiling.

Three permissions remain independent:

1. Can this member discover/connect this integration in this workspace?
2. Can this actor use this particular account, operation, and resource through Ofz?
3. Can the provider account itself access that operation/resource?

Registering an integration, connecting an account, granting a platform permission, and approving an individual
effectful action are separate events. The UI should combine steps only when doing so has a clear meaning to the user.

## Shared connection lifecycle

Keep one reusable platform flow for Tengri, OpenCode, and later clients:

1. The authenticated client asks for a short-lived connection attempt for one integration and administrative workspace.
2. The backend computes eligible accounts, operations, and resources from current policy. The browser cannot widen them.
3. The member selects a shared account, completes provider authentication, or supplies a required credential through
   the protected connection UI. Existing backend state preserves the chosen task and resource selection.
4. The backend validates callback ownership and provider account identity, maintains credentials server-side, and
   records the resulting connection and consent.
5. Relay validates the connection; the consuming runtime acknowledges installation where applicable.
6. Only then is the connection ready for that consumer. Publish tool availability into the existing chat without
   requiring a new conversation or browser reload.

Do not represent readiness with one optimistic boolean. Derive the user-facing status from the provider connection,
current Ofz permission, and consumer installation state. A successful OAuth callback alone does not prove the agent
can execute a tool. A runtime restart should reinstall an authorized connection, rather than force the user through
provider login or permission assignment again.

OAuth2 is an authentication option shared by HTTP and MCP drivers. MCP stdio and CLI use a reviewed process profile;
HTTP-based MCP uses the registered endpoint and appropriate upstream auth. A custom standards-conforming MCP server
uses the same driver with a separate definition and policy mapping. Execute only approved operations; discovered
tools and their annotations do not grant access.

Use a maintained protocol implementation where it satisfies the required contract. Keep credential storage,
refresh coordination, callback handling, revocation, and connection ownership in shared platform code. Do not
reimplement these in both clients or introduce a new credential microservice solely for this split.

## Authentication and run continuity

Use the existing identity provider for SSO between product and portal, with separate host-only cookies, exact origins,
and separately enrolled gateway identities. Do not widen the existing browser cookie to every subdomain or let an
admin frontend impersonate the Tengri gateway. Extract the necessary session operations into the shared platform
interface and migrate callers together, preserving passkeys, verified identity, and current permission checks.

There is a concrete continuity defect to address before calling the experience smooth:

- [Session establishment](../../services/ofz/src/sessions.rs) revokes the previous browser session when replacing it.
- [Durable runs](../../services/tengri/src/runs.rs) retain their admitted principal. Observation can then encounter the
  revoked session and enter `needs_reconciliation`.
- [The chat activity message](../../apps/landing/src/components/tengri/agent-chat.tsx) collapses that state into a generic
  unconfirmed-action warning, hiding the actionable reason.

Reauthentication must have an explicit, audited continuity path for the same run, user, workspace, and allowed scope.
Reconcile the original accepted operation before changing execution state. Never solve this by reviving a revoked
session, treating any later login as authority for all old work, or resending a potentially completed action.
Explicit logout, security revocation, membership removal, and resource permission removal must remain effective.
Portal step-up authentication must not accidentally orphan an unrelated active Tengri run.

Sensitive administrative changes can require fresh verification at the relevant Save action. Ordinary connection
use, already-approved consent, and background credential renewal must not inherit that requirement unnecessarily.

## Implementation sequence and acceptance

| Unit                                      | Deliverable                                                                                                                                                  | Required proof                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Run/session continuity                 | Distinguish session replacement from actual loss of authority; restore authorized observation of the same accepted run; show a useful recovery reason.       | Reauthenticate during a running turn and retain its identity, draft, and outcome. Explicit revocation and a different user's login remain denied. No second dispatch.                                         |
| 2. Workspace policy and gateway contracts | Add administrative workspace ownership, bounded admin permissions, and the shared human gateway/session interface.                                           | Admin A cannot list, edit, or execute through workspace B by changing URLs or request IDs. Runtime ownership alone grants no external resource access.                                                        |
| 3. Portal and hard UI cutover             | Add the separate frontend using the existing design system; move current admin responsibilities and remove their product entry points and replaced handlers. | A member can complete product setup without seeing administrative fields. Old administrative product URLs no longer serve an alternate implementation. Portal controls still require server authorization.    |
| 4. Kubernetes member flow                 | Use preapproved installation/resource scope, record consent, install and acknowledge credentials, and refresh tools in the same conversation.                | One Connect action where no account choice/auth is needed; real status/log/event results and receipts from Tengri and independent OpenCode. No new resource grants from routine Connect.                      |
| 5. HTTP/MCP/CLI and provider connections  | Add shared drivers and the provider-credential lifecycle; qualify one concrete integration for each supported path.                                          | Provider callback cancellation, duplicate callback, token expiry, reconnect, scope increase, process failure, catalog changes, and account isolation behave correctly. Reconnect retains connection identity. |
| 6. Release and product qualification      | Enroll the admin app in existing immutable image publication, Kargo, and Argo delivery; migrate the coordinated contracts and remove replaced code.          | Required exact-head CI and review, source/image provenance, committed promotion, runtime revision, desktop/mobile flows, and real allowed/denied execution receipts.                                          |

The hard migration needs an explicit mapping for current identities, workspace resources, consent, and grants.
Preserve their existing effective access; stop on ambiguous mappings rather than broadening permissions. Apply the
reviewed schema/data migration and coordinated rollout through existing release gates. Do not keep two policy editors,
parallel authorization implementations, or legacy endpoints as the development strategy.

Implementation ownership stays concentrated: the independent admin deployment reuses `apps/landing` and its image, shared platform frontend
and server helpers, Ofz policy/session changes, and Relay connection/driver changes. Reuse the existing Next.js,
Tailwind, zinc, and design components. Add only the shared code actually consumed by both frontends.

## Experience gates and measurement

Measure the connection funnel through start, provider authorization, validated connection, consumer readiness,
and first successful tool call. Track policy denial, provider failure, cancellation, repeated verification,
and abandonment separately. Provider interaction time must be separated from our internal latency. These are
proposed measurement gates, not measured improvements.

Acceptance scenarios include:

- An ordinary member connects an approved integration without entering an administrator screen.
- A workspace-managed account is usable without exposing its credentials or asking every member to authenticate it.
- Request access preserves intent; approval makes the integration available without another policy form.
- Reconnect updates the existing connection and does not recreate consent, duplicate accounts, or widen access.
- Passkey verification during active work does not strand the admitted run.
- Agent and provider credentials never appear in model context, URLs, UI diagnostics, or audit log bodies.
- The same account/connection rules hold across Tengri and standalone OpenCode.
- A connector failure has a local, actionable status; it does not masquerade as a complete agent outage.
- Mobile provider return, keyboard focus, Back, cancellation, scroll, and unsent drafts remain stable.
- The backend verifies unknown outcomes before retrying any action that might have reached its destination.
- Functional connection probes and notification routing are tested in addition to infrastructure health alerts.

Open product details are the final admin hostname, visual composition, and provider-specific account/resource
pickers. The recommendation is to use `admin.proompteng.ai`, preserve the existing product design system, and
qualify Kubernetes first. None of those details requires exposing administrative controls in Tengri again.
