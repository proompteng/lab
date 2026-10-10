# Ofz enterprise authorization implementation plan

Status: In implementation. Production qualification is pending; see [the implementation status](ofz-implementation-status.md).

Created October 9, 2026. Source baseline: `f65e44e0c2703fb50adace16740f6d57895d4460` on
`proompteng/lab` main. The intervening changes since the preceding authorization investigation affect Bayn only.
Cluster observations belong to that investigation; this document does not claim a new runtime acceptance run.

## Outcome and scope

Make Ofz the central authority for every Tengri-associated service. Every protected request must identify its actor,
action, and resource, obtain a current authorization decision, and enforce that decision before an effect or disclosure.

Cover the Landing BFF, Tengri controller, slot runner and supervisor, Nanoagent, files, terminal, Codex, editor, browser,
preview gateway, Kubernetes diagnostic broker, and connector broker. Cover humans, delegated agents, and workloads.

Target the internal production platform, `platform:lab`. Customer organizations, enterprise provisioning, SCIM, and
customer tenant qualification require a separate scope decision. Unrelated lab applications are outside this migration.

One owner executes the plan. Use native GitHub stacks and the repository's existing review and delivery gates. Do not
spawn subagents. Perform one hard migration and remove the previous enforcement contract. Preserve retained homes,
conversations, drafts, and approved ownership. Plan creation does not start implementation or deployment.

## Architecture decisions

1. Keep the existing SpiceDB deployment in the Ofz namespace as the relationship and permission authority.
2. Add a small Rust API in `services/ofz`. It owns typed authorization checks, policy commands, delegation, admission,
   and audit receipts. Normal applications cannot write arbitrary tuples or hold the native SpiceDB credential.
3. Use the installed Keycloak service for brokered GitHub authentication and WebAuthn. Keep authorization roles in Ofz.
4. Keep the existing SPIFFE identities, mTLS boundaries, and signed BFF request transport. Extend authenticated context
   with actor kind, subject, session or grant ID, action, workspace UID, runtime epoch, request hash, and deadline.
5. Add `ofz_control` and `tengri_control` databases to the existing Ofz CNPG cluster with separate application roles.
   The former holds policy commands, credential hashes, quota reservations, and the audit outbox. The latter holds BFF
   sessions, tickets, preview sessions, and replay state. Do not query or modify SpiceDB's internal tables.
6. Keep one diagnostic implementation behind typed HTTP and MCP adapters. Do not add Redis, another policy engine,
   a generic policy language, or a new AI execution service.
7. Use current, fully consistent checks for the first release. No owner-label fallback, cached positive decision, or
   previous protocol can authorize an operation after cutover.

The browser receives no native Ofz credential. Supervisors accept only the exact controller identity and matching
workspace UID/epoch. Guests receive neither a Kubernetes token nor the host Workload API identity. Administrative
policy commands accept only the BFF workload with verified human authentication and fresh step-up evidence.

## Policy model

Use platform, human, agent, workload, workspace, agent-grant, Kubernetes-namespace, and connector-connection resources.
Bind a workspace to its MicroVM UID. Bind Kubernetes targets to cluster identity and namespace UID. Names and labels
remain navigation metadata.

| Role                   | Permissions                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Platform administrator | Admit and suspend members, assign platform roles, set quotas, and approve broker targets. Workspace content requires a separate grant. |
| Platform auditor       | Read policy configuration and audit receipts.                                                                                          |
| Platform operator      | Inspect platform health and fence a workspace. No content or grant administration.                                                     |
| Workspace Owner        | Exactly one Owner. Manage collaborators and diagnostic grants, transfer ownership, and administer the guest.                           |
| Workspace Developer    | Full shared guest authority, including terminal, editor, Codex, interactive browser, and previews. No collaborator administration.     |
| Workspace Viewer       | Approved workspace metadata and scoped observation. No execution or lifecycle changes.                                                 |
| Diagnostic agent       | Expiring, explicitly scoped observation within its issuer's current authority. No further delegation.                                  |

Require active platform membership in addition to workspace roles. Sign-in does not grant membership or permission to
create a workspace. Platform suspension denies all effective workspace access and dependent delegated grants.

Require two verified platform administrators at bootstrap and prevent changes that leave fewer than two active
administrators. Require fresh WebAuthn authentication, at most five minutes old, for grants, ownership transfer,
destructive actions, membership changes, and emergency access. Require WebAuthn for privileged roles and Developer
access. Emergency content access requires two custodians, a reason and incident ID, and an expiry of at most 30 minutes.

Preserve canonical human identities derived from numeric GitHub IDs. Map Keycloak subjects through verified broker
identities. Never link accounts by email, login name, or user-editable attributes. Use database-backed BFF sessions with
an eight-hour maximum and a 30-minute idle timeout. Remove the direct GitHub provider and stateless session cache at
cutover. A current Ofz membership check remains mandatory on every protected operation.

Reserve creation and storage quotas atomically before allocation. Initial defaults are at most two total workspaces per
member, one active workspace, and 64 GiB of home reservation. Preserve the researched main fleet limit of six workspaces,
six prepared slots, and 192 GiB of home storage, with 32 GiB per default home. Quarantined and retained homes still count.
Reconcile reservations with actual MicroVM/PVC state; retries cannot spend capacity twice. Quota increases are explicit
and audited.

## Enforcement contract for each service

| Component             | Required enforcement                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BFF                   | Authenticate and admit every route, bind actor context, validate origins, and expose only authorized workspaces and actions.                                       |
| Controller            | Classify all RPCs. Check each lifecycle, configuration, secret, data, and ticket operation separately.                                                             |
| Runner and supervisor | Verify exact controller peer, slot claim, workspace UID, runtime epoch, and controller fencing generation.                                                         |
| Nanoagent             | Receive controller-signed action/resource context on every RPC, with only the verification key in the guest. The transport token does not confer a human role.     |
| Files                 | Separate scoped reads/events from mutations. Anchor allowed roots and reject traversal, magic links, and symlink escapes. Exclude known credential paths.          |
| Terminal              | Add a bounded output observer. Keep create, input, resize, close, and interactive attachment privileged. Observation cannot take the exclusive terminal lease.     |
| Codex                 | Use native history reads and non-refreshing account status. Keep resume, execution, interruption, approvals, settings, login/logout, and token refresh privileged. |
| Editor                | Require Developer or Owner for the full editor, terminal, extensions, proxy routes, and WebSockets. Scoped file observation uses the Files API.                    |
| Browser               | Separate existing-browser status and opt-in screenshots from launch, navigation, input, downloads, and interactive control. Respect Take Control state.            |
| Preview gateway       | Permit scoped metadata observation. Require Developer or Owner to open the application or proxy HTTP/WebSocket traffic. HTTP GET is not a read-only guarantee.     |
| Kubernetes broker     | Combine current Ofz target grants with a dedicated service account and restricted native RBAC. Return approved projections.                                        |
| Connector broker      | Check reviewed tool, connection, argument schema, credential scope, and resource target on every invocation.                                                       |
| Ofz API               | Own checks, policy mutation, admission, delegation, credential lifecycle, and durable receipts. Reject arbitrary tuple writes.                                     |

Start from the researched 36 controller RPCs and 19 guest RPCs. Enumerate every HTTP, RPC, gateway, WebSocket, and MCP
operation in CI. A new unclassified operation must fail the contract check. Unknown actions deny by default.

Reads cannot wake a stopped guest, extend idle time, refresh credentials, resume Codex, change options, or acquire
browser/terminal control. Return an explicit stopped-state response. Use the pinned Codex native thread-read, item-list,
and turn-list methods. Preserve required completion, cursors, empty turns, and the 10 MiB page, 64 MiB total, 256-page,
and 90-second history limits. Preserve current image replay and retained-home growth behavior.

Bind tickets and preview sessions to actor, session/grant, workspace UID, runtime epoch, permission, origin, and expiry.
Check at issuance and redemption. Recheck active streams at least once per second with a two-second authorization
deadline. Close within three seconds of a committed revocation or authorization-service loss. Bound rechecks for
downloads and pagination. Cross-workspace lookups must not disclose resource existence.

## Delegated diagnostic access

Expose `/api/tengri/mcp` and typed diagnostic routes through the BFF. Issue a random 256-bit opaque credential, store
only its hash, and bind it to grant ID, issuer, workspace UID, audience, proof key, and expiry. Show it once. Never place
it in URLs, browser storage, guest homes, or logs.

Use a 15-minute default grant and one-hour maximum. Renewal requires the issuer's current authority and the same or
narrower scope. Use native SpiceDB expiration and its datastore clock. Every request checks grant validity, active
issuer membership, delegation authority, action, and resource scope at one fully consistent bulk-check revision.
Namespace and connector calls also require the issuer's current permission on that target.

Bind external credentials using DPoP validation of method, canonical URI, token hash, nonce, proof age, and unique
proof ID. Share atomic replay state across replicas and provide a compatible agent client adapter. Do not silently
accept an unbound bearer token.

Default to workspace metadata. The Owner explicitly selects file roots, conversation IDs, terminal-output cursors,
screenshots, namespace targets, and connector targets. Empty scope grants no additional data. The UI explains that
selected content may contain private data; generic secret redaction is not a promised security boundary.

Start with 10 unary calls per second and two streams per grant. Use the existing bounded history/output budgets and
tighter operation-specific limits where needed. Rate, size, and completeness failures return explicit errors.

The Owner's current Codex remains a privileged guest process with passwordless sudo. The diagnostic identity never
receives its terminal, bootstrap token, Kubernetes credentials, or provider credentials.

## Kubernetes and connector boundaries

Create a dedicated Kubernetes broker service account. Initially eligible namespaces are `tengri`, `proompteng`, and
`ofz`; actual delegated target sets start empty. Platform administrators approve target permissions, and Owners may
delegate only their approved subset.

Allow reviewed get/list/watch status projections and separately granted bounded logs/events. Do not return whole Pod
specifications, environment values, or unrestricted annotations. Deny Secrets, ConfigMaps, TokenRequests, exec,
attach, port-forward, proxy, impersonation, node access, writes, raw URLs, and arbitrary CLI flags.

The existing Agents Shell cluster-admin service account cannot serve this broker. Verify native effective permissions
with SubjectAccessReview and real denied requests. A parser allowlist is insufficient.

For connectors, pin a reviewed tool catalog and enforce connection IDs, argument schemas, resource scopes, upstream
credential permissions, public HTTPS destinations, DNS/IP validation and pinning, redirect rejection, and response
limits. Reuse useful Relay validation code without its duplicate ownership graph, native Ofz credential distribution,
or guest-SVID assumption. Do not expose arbitrary servers, write tools, or OAuth onboarding in the first profile.

## Durable changes, audit, and failure handling

Write a durable command intent before changing relationships. Include operation ID, actor, caller workload, reason,
expected versions, before/after relationships, and trace ID. Serialize conflicting resource operations and reconcile an
unfinished command before processing its successor.

Commit relationship updates, policy-version transitions, and an applied-operation marker in one SpiceDB transaction
with preconditions. Persist the final receipt before acknowledging success. After a crash, inspect the marker and
version before retrying. Never replay an old grant after a newer revocation. Distinguish a recovered observed revision
from a lost original receipt.

Audit policy changes, grants, revocations, privileged access, ownership transfer, broker calls, protected-data access,
and stream open/close/revocation. Continuing stream rechecks are telemetry under the stream's access receipt. Keep
tokens, credentials, prompts, and source contents out of audit metadata.

Export a durable outbox to independent immutable storage with sequence numbers, batch hashes, checksums, and receipts.
Application writers cannot delete acknowledged objects. Keep policy/admin records for one year, with 90 days
searchable, and protected-access receipts for 90 days. Purge SQL export spool entries only after acknowledgement and a
24-hour safety period. Operational logs are not the immutable archive.

Stop new grants and protected data/tool access when recording fails or archive lag exceeds 60 seconds. Keep revocations
and suspensions available while the local journal works. If the journal fails, use the narrowly scoped operator fence,
record the incident independently, and reconcile before reopening. Do not claim a mutation committed without evidence.

Add default-deny Ofz NetworkPolicies, exact workload authorization, encrypted verified database transport, per-role
database access, connection budgets, and overload handling. Native SpiceDB access belongs only to the Ofz API and
reviewed short-lived migration jobs. Open-source SpiceDB telemetry does not supply the required application audit.

## Availability, offboarding, and recovery

Run two BFF, controller, Ofz API, and exposed broker replicas across hosts. Retain three SpiceDB and synchronous Ofz
CNPG instances. Add two Keycloak server replicas and a three-instance synchronous, host-spread Keycloak database with
independent backups before relying on it for production Tengri sign-in.

Use one controller reconciliation leader with a 15-second Lease and five-second renewal. Install its fencing generation
atomically on each affected supervisor before acting. Supervisors reject older generations. Restarted slots have fresh
epochs. Persist lifecycle intent; API replicas cannot independently run competing pool/lifecycle loops. Budget the extra
leader Lease separately from the six slot Leases.

Replace in-process tickets and preview maps with shared state and atomic redemption. Share session revocation and
replay state. Keep transient WebSocket buffers local, with persisted identity needed to reconnect and reauthorize.
Replica loss may interrupt a connection but cannot duplicate a redemption or slot claim.

Developer removal, Owner transfer, and member suspension must revoke mediated access, dependent grants, sessions, and
tickets, then fence affected shared guests. Stop the guest and its egress within 30 seconds. Quarantine the retained
home. Restart requires revoking or rotating exposed credentials and rebuilding a clean environment with reviewed data.
Keep original history and homes retained. An API revoke cannot erase copied credentials or stop an existing root process.
Complete IdP disable/sign-out as part of the workflow and reconcile out-of-band identity changes.

Use an independent S3-compatible destination for WAL, tested base backups, immutable audit, home mappings, and retained
homes. Keep 30 days of database point-in-time recovery. A physical Ofz backup includes its three application/datastore
databases at one recovery point. Keep decryption and identity-recovery authority outside cluster-administrator
credentials. Current Ceph-local backups do not satisfy this boundary.

Restore with application access fenced. Reconcile policy versions, complete command receipts, pending operations,
current membership, and workspace/home UIDs. Invalidate restored sessions, tickets, and agent credentials through a new
recovery generation. Uncertain grants stay disabled until reapproved. A revoked-after-backup grant must remain denied.
Exercise recovery quarterly and after material schema or credential changes.

## Implementation phases and gates

Every phase needs local validation, staging behavior, and relevant performance/failure evidence. Publish evidence
against exact commits, image digests, schema hash, and configuration. Use existing CI and automatic Codex review.
Resolve actionable findings before merge. Implement phases in order, using native dependent PRs where useful.

| Phase                           | Owned paths and work                                                                                                       | Exit gate                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1. Contracts                   | `proto/proompteng/authz/v1/authz.proto`, final schema, permission/profile catalog, and service-operation inventory         | Role matrix, expiry, live parent revocation, and unknown/unclassified-action tests pass in disposable SpiceDB.                                         |
| P2. Ofz API                     | `services/ofz`, database migrations, typed commands/checks, admission, audit outbox, and `argocd/applications/ofz`         | Crash at every command boundary, lost response, stale version, and concurrent quota/role changes cannot duplicate an effect or resurrect a grant.      |
| P3. Identity and administration | Landing auth/session code, Keycloak definitions, membership operations, and Access UI                                      | Browser tests cover admission, verified identity mapping, MFA, role changes, last-administrator protection, quotas, and session revocation.            |
| P4. Shared state and HA         | `services/tengri/src/tickets.rs`, controller leadership, shared state, replica/database definitions, and Keycloak failover | Cross-replica redemption is exactly once; stale leaders are rejected; replica loss and database switchover preserve policy and slot correctness.       |
| P5. Runtime enforcement         | Controller/Nanoagent RPCs, observers, gateways, files, terminal, Codex, browser/editor, and workspace UI                   | Full role/service matrix passes; read-only tests cause zero guest side effects; live revocation closes every channel on time.                          |
| P6. Agents and brokers          | Restricted MCP/HTTP routes, proof-key adapter, grants UI, Kubernetes broker/roles, and connector integration               | Actual external-agent calls, proof replay, wrong targets, parent revocation, path escape, native RBAC denial, SSRF, and output-limit tests pass.       |
| P7. Operations                  | Offboarding/quarantine workflows, independent audit/backups, alerts, and recovery runbooks                                 | Privileged offboarding and isolated restore pass, including copied-credential checkpoints, missing journal intervals, and revoked-after-backup grants. |
| P8. Hard cutover                | One-shot migrator, version/epoch handshake, legacy removal, credential rotation, GitOps wiring, and qualification evidence | Two staging migration rehearsals, complete browser acceptance, failure probes, and a 24-hour mixed-workload soak pass on the exact release.            |

Relevant existing checks include Tengri Rust tests, `services/tengri/test-authz.sh`, Landing tests and focused browser
E2E, generated-protocol checks, affected formatting/lint, and manifest rendering/validation. Add new Ofz integration and
failure probes as owned implementation work. A blocked environment check is not a pass.

## Hard migration procedure

- [ ] Rehearse the complete migration in staging and record the exact image/schema/configuration set.
- [ ] Obtain the reviewed maintenance window and fence old callers before changing authority.
- [ ] Export current Ofz grants and verified MicroVM/home UID mappings. Preserve revoked-enrollment markers.
- [ ] Apply the final schema and seed only approved current relationships against UID resources. Never infer a missing
      grant from an owner label.
- [ ] Verify owners, membership, denial cases, quota reservations, command receipts, and preserved data before opening
      access.
- [ ] Rotate the native SpiceDB key, remove its controller mount, and reject old credentials and incompatible callers.
- [ ] Activate the new BFF, controller, Ofz, guest, and broker contracts together through reviewed Kargo/Argo desired
      state. Delete old name-based graph objects and the legacy authorization path after validation.
- [ ] Record remote commits, publication receipts, Freight/Stage, generated Kargo revision, Argo revision, actual images,
      schema hash, migration receipt, and product acceptance for an explicitly authorized production rollout.

Keep production preparation in staging until the coordinated cutover is ready. Do not bypass promotion gates or run
two production authorization implementations. Recovery uses a known-safe new-contract image or forward fix. Any
database restore remains fenced until revocation and current-membership reconciliation succeeds.

## Enterprise release acceptance

The following are targets to prove, not measured properties of the current deployment.

| Requirement            | Pass condition                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coverage               | Every protected HTTP/RPC/gateway/tool operation has tested allow, deny, wrong-resource, and invalid-caller cases.                                       |
| Strict observation     | Zero guest starts, idle extensions, token refreshes, terminal input, Codex mutation, browser control, or tool writes from the diagnostic suite.         |
| Revocation             | New operations use committed current policy; active streams close within three seconds.                                                                 |
| Durability             | Crash/retry tests cannot lose an acknowledged policy change, duplicate its effect, or replay a stale grant.                                             |
| Availability           | Authorization API monthly SLO is 99.9%, supported by single-node/replica fault exercises and a 24-hour qualification soak.                              |
| Latency and capacity   | p99 check latency at most 150 ms at 100 decisions/second sustained, including 50 streams, and a 250/second burst for 30 seconds.                        |
| Dependency failure     | Two-second check deadline, explicit unavailable responses, bounded overload, and no positive authorization fallback.                                    |
| HA                     | API/leader failover and reconnect within 30 seconds; ticket redemption and slot ownership stay unique.                                                  |
| Offboarding            | Mediated access closes within three seconds and guest/egress fencing within 30 seconds. Reopen requires completed credential and trusted-home recovery. |
| Audit                  | Durable mutation/access receipts and at most 60 seconds of independent immutable archive lag.                                                           |
| Authorization recovery | Independent RPO at most five minutes and isolated RTO at most 60 minutes, with restored credentials invalidated and uncertain grants denied.            |
| Home recovery          | Independent RPO at most 24 hours and complete current-size home restore within four hours, verified by checksums and history.                           |
| Product preservation   | Retained homes, workspace/draft isolation, editor/browser/terminal behavior, and exact large-conversation restoration pass.                             |
| Review                 | Required CI at the exact release heads, automatic review findings resolved, and a separate review of trust boundaries and recovery evidence.            |

Use the prior 14,944,963-byte, 2,074-item, 27-turn conversation as a required regression fixture. Require complete
reconstruction, no restoration HTTP 503, and no more than a 20% replay-time regression against the trunk baseline.
The previous repair does not establish acceptance of this migration.

Add bounded-label metrics and alerts for authorization errors/deadlines, revocation delay, unexpected callers/actions,
expired grants, stale leaders, quota drift, audit lag, backup age, restore age, and identity drift. Correlate traces across
BFF, Ofz, controller, supervisor, guest, and brokers without recording private content.

## Inputs required before rollout

- Select the independent backup/audit destination, account, region, retention policy, credentials, and cost. Prefer an
  existing independent destination. A separate-account S3-compatible store with Object Lock is the default proposal for
  a new destination; no provisioning or purchase follows from this plan.
- Identify the two administrator/custodian accounts and verify their canonical identities and recovery credentials.
- Confirm the maintenance window and whether the intended enterprise boundary is the internal platform described here.
- Revalidate current source and runtime before implementation and production acceptance. Do not turn these proposed
  controls into claims of deployed behavior.

## Source and operating references

- [Tengri implementation and host boundary](../../services/tengri/README.md)
- [Current authorization code](../../services/tengri/src/authz.rs), [schema](../../services/tengri/src/authz.zed),
  [ticket state](../../services/tengri/src/tickets.rs), and [BFF authentication](../../apps/landing/src/lib/tengri/auth.ts)
- [Ofz datastore and backup configuration](../../argocd/applications/ofz/README.md)
- [Keycloak desired state](../../argocd/applications/keycloak/keycloak.yaml)
- [Fleet quotas at the research baseline](https://github.com/proompteng/lab/blob/f65e44e0c2703fb50adace16740f6d57895d4460/argocd/applications/tengri/resource-quota.yaml)
- [Release authority and evidence](../release-automation.md), [Tengri operations](operations.md), and
  [documentation authority](../documentation-authority.md)
- [SpiceDB native expiration](https://authzed.com/docs/spicedb/concepts/expiring-relationships),
  [consistency](https://authzed.com/docs/spicedb/concepts/consistency), and
  [atomic API preconditions](https://github.com/authzed/api/blob/main/authzed/api/v1/permission_service.proto)
- [SpiceDB telemetry and audit distinction](https://authzed.com/docs/spicedb/ops/observability)
- [Keycloak authentication and step-up](https://www.keycloak.org/docs/latest/server_admin/index.html) and
  [HA guidance](https://www.keycloak.org/high-availability/introduction). Validate against the installed version.
- [DPoP specification](https://www.rfc-editor.org/rfc/rfc9449.html)
- [Kubernetes RBAC guidance](https://kubernetes.io/docs/concepts/security/rbac-good-practices/)
- [OWASP audit guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [Pinned Codex thread-read implementation](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/thread_processor.rs#L2824)
