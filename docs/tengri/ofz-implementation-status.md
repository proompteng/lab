# Ofz implementation status

The goal is the complete migration and deployed acceptance described in
[the authorization plan](ofz-enterprise-authorization-plan.md). Work proceeds through dependent PRs, without subagents.
Production keeps its current authority until the coordinated hard cutover. New code has no legacy authorization fallback.

- [x] Read repository instructions and Poteto principles; refresh source and runtime baseline.
- [x] Verify the requested administrator: `gregkonush`, GitHub numeric ID `12027037`.
- [x] Verify the second administrator/custodian: `tuslagch`, GitHub numeric ID `241203724`.
- [x] Identify the requested independent recovery host: `nuc.ide-newton.ts.net`.
- [x] P1: final schema, typed API, action inventory, real SpiceDB role/expiry/revocation tests.
- [x] P2 source and isolated control proof: Ofz service, durable commands, quotas, audit and database migrations.
- [x] P3 source and isolated browser proof: Keycloak identity, shared sessions and Access UI.
- [ ] P4: shared tickets, leadership and failover.
- [ ] P5: enforce every runtime channel and add pure observers.
- [ ] P6: proof-bound diagnostic grants, Kubernetes and connector brokers.
- [ ] P7: offboarding, independent archive/backups and isolated restore.
- [ ] P8: migration rehearsals, reviewed release, hard cutover and full product acceptance.

Both required custodians are named and their numeric identities verified. NUC has approximately 63 GiB free at the
initial readback, below the 192 GiB uncompressed home-storage ceiling. Database recovery and home recovery must each
be qualified against actual retained data and available space.

Evidence and decisions are recorded in [the implementation trail](ofz-implementation-decisions.tsv).

The runtime checkpoint's review regressions now exercise signed controller calls against the real passkey-backed Ofz
session and PostgreSQL/SpiceDB fixture. Workspace listing returns only the registered, authorized workspace and skips
an unavailable UID. Creation completes after a 5.1-second delay by checking the current session under a fresh two-second
metadata decision; submitting the original expired request again remains denied. Each regression fails against its
prior implementation. The full pinned-container identity fixture passes all 54 browser assertions and its controller
wire checks. The isolated shared-state fixture passes all 19 tests, including bounded reconnection after terminating a
database backend, with the accepted nonce denied throughout. A concurrent fixture run hit the configured database
connection timeout; production deadlines were retained and the complete isolated rerun passed. Generated slot Pods
now mount the supervisor's restricted SQL password and CA only into that container. Nix source evaluation also verifies
that the shared request-signature vector reaches the Proompteng build unchanged. Remote CI for these fixes is pending.

P1 local evidence: 492 permission assertions against pinned SpiceDB and PostgreSQL; five Rust contract tests; five
inventory tests including deliberately unclassified RPC and HTTP changes; Buf lint; Clippy; Rust/Python/shell checks.
The catalog covers 163 current operations across eleven surfaces, including each HTTP method and Axum's implicit HEAD.
Delegation checks bind the recorded issuer and
workspace, including wrong-workspace replay and missing-binding denial. HTTP inventory covers both Go registration
APIs across every guest source file. This is contract proof, with runtime enforcement
and production qualification still pending. Native dispatch caching failed the expiration probe and remains disabled
in the qualification fixture; the release must preserve that setting.

P2 local evidence: the nine-RPC Rust service and TLS-only control database passed Clippy and the unit/contract suite.
The isolated PostgreSQL/SpiceDB control fixture passed with 16 committed commands and 41 immutable audit receipts.
It exercises crash recovery before native writes, after native writes and after SQL receipts; lost responses; version and
operation conflicts; concurrent quota reservations; minimum-administrator protection; independent emergency approvals;
hash-only show-once grants; expiry and issuer revocation; exact stream context; native/journal/archive failure; and
ownership quarantine before native transfer and before receipt recovery. The policy fixture now checks 509 assertions.
The prepared seven-resource control-plane configuration passed Kubernetes server-side dry run and remains excluded
from active GitOps. Real BFF/Ofz mTLS interoperability, OIDC sessions, fleet enforcement and deployment remain later gates.

P2 review regressions additionally passed against local PostgreSQL 18.1 and the checksum-verified official SpiceDB
1.56.2 Darwin ARM64 binary: 21 commands and 60 immutable receipts, including repeated roles, controller administration
and human-read denial, emergency roster visibility and removal across readmission, control-only idle extension,
idempotent logout and establishment recovery, rejection of live runtime epoch replacement, and archive backlog
fencing despite a fresh heartbeat or a failure during a native check. Each of the three latest behavioral regressions
fails with its previous implementation and passes after the fix. Additional regressions reject single-factor privileged
reads and controller enrollment while the archive is unhealthy, and pass with an older verified passkey for ordinary
policy/audit reads. The current policy fixture passes 587
assertions. The exact pinned PostgreSQL 18.6 and SpiceDB container fixture also passed on NUC with 21 commands and
60 immutable receipts. Operational test grants remain live throughout remote offboarding checks; expiry is tested
separately. The in-flight archive race has a bounded barrier timeout. NUC access uses the same existing key, whose
fingerprint matches the configured SSH agent, without changing the account or credential identity.

P3 local evidence: Keycloak 26.7.3 with Java 21, real TLS PostgreSQL 18.1, SpiceDB 1.56.2, Ofz and the BFF passed the
isolated Chromium fixture with a synthetic GitHub upstream and virtual user-verified passkeys. The fixture checks
duplicate-email identity separation, admission denial with an immutable receipt, browser membership/quota changes,
the two-administrator minimum, stale MFA rejection, fresh passkey step-up, downgraded assurance rejection, atomic
session-cookie replacement, shared SQL inspection, logout revocation and HEAD/replay rejection. The Landing suite
passed 296 tests. The current control fixture passed 26 commands and 79 immutable receipts. The expanded browser fixture
passes 44 assertions under pinned Bun 1.4.2, including permission checks before external identity resolution and real
GitHub/BFF credential rotation without replacing users or passkeys. A simulated lost response after real session
establishment recovers the same credential with one session and one successful audit receipt; disabling BFF recovery
fails the actual browser flow. Command preflight remains available for revocation
under archive loss and never renews idle activity. Both the 26-command control fixture and the 44-assertion browser
fixture also passed against the exact PostgreSQL 18.6 and SpiceDB containers on NUC. Twenty-two inventory regressions,
TypeScript, type-aware lint, generated-client verification and strict prepared-manifest validation passed after
restacking onto current main. The corrected dependency hashes passed native Linux image builds on both architectures
at commit `371f53f7a2`; all required CI checks passed there. The emergency-access catalog classification was then aligned
with the enforced administrator permission and covered by the Rust contract suite. Logout now classifies its actual
session-revocation action. The pinned identity fixture passed all 44 assertions again after waiting for Keycloak's
deferred WebAuthn module before clicking its registration and authentication buttons. Real custodian enrollment and
deployed product proof remain later gates.

The follow-up command-recovery fixture passed 52 browser assertions and 297 Landing tests. It commits a self-demotion,
loses the successful response, and recovers the original receipt after administrator authority is gone without another
GitHub lookup. A changed request with that operation ID returns 409. Ofz binds this recovery to the original validated
BFF request hash; the real 26-command / 79-receipt control fixture also verifies recovery after ownership transfer and
hash collision rejection. Cancelled OIDC callbacks clear their attempt cookie; that regression returns 400 against the
prior source and the required 401 with the fix. Eight Rust units, Clippy, TypeScript and 22 inventory regressions pass.

The coordinated cutover gate also covers the Proompteng image: Kargo discovery remains withheld while
`TENGRI_PREPARED_SLOT_CUTOVER_READY` is false. This was verified against the repository variable and workflow input;
the production BFF remains on its previous image. Rate limits use the connection peer, so clients reaching the
LoadBalancer cannot choose buckets with proxy headers. Tunnel clients share the tunnel Pod's bucket. An isolated
Traefik 3.7.13 fixture on NUC reproduced seven admitted requests with rotating headers under the previous configuration
and returned HTTP 429 on the seventh request under the corrected configuration. This is isolated ingress proof;
production ingress acceptance remains part of P8. Fifty-seven focused inventory, rollout and ingress checks pass.
The enabled-app inventory follows declared nested Kustomize inputs, excluding prepared directories until referenced;
only Ofz's classification changed in the current repository inventory.

P4 source is in progress. The real PostgreSQL 18.6 / SpiceDB fixture passes 19 shared-runtime tests, including
atomic one-use redemption across replicas, bounded pool failure, hash-only storage, preview/session/owner/epoch
isolation, global capacity and expiry, signed body/replay rejection, database leader CAS/expiry, supervisor role
restrictions, replay protection after a database backend dies, and cleanup that preserves replaced homes or unproven
writers. The Rust unit suite passes 120 tests with 23 explicit integration/native fixtures excluded. Two real Go/Rust
RPC interoperability fixtures also pass. The Landing suite passes 303 tests and TypeScript; 24 release-workflow and
22 inventory regressions pass. The real control fixture passes 29 commands with 91 immutable receipts.

The Chromium/Keycloak/Ofz fixture passes 54 assertions, including the real controller SPIFFE connection, an immutable
runtime receipt after a later stop, bounded stream revocation, and recovery of the same passkey session after the serving
Ofz process is killed. Its TCP proxy models endpoint removal; this does not establish Kubernetes or database failover.
The current patch removes the direct-SpiceDB client/schema and ConfigMap nonce path, uses stable lifecycle operation IDs
with a separate original-request hash, and waits for the controller's observed policy version before acknowledging a
transition. It projects Ofz's current owner while preserving the retained-home binding. Breaking CRD changes remain
prepared for the coordinated cutover. P4 has not been merged or deployed; replica/database deployment,
Keycloak HA and native KVM qualification remain open.

P3 merged as PR #14906 at `75b75987f047edaf1a6403a0556d5189af667065` on 2026-10-10. All required checks,
including native image builds on both architectures, passed on its reviewed head. This is source/CI evidence; the
release hold and live identity/custodian gates remain. P4's breaking CRD is staged under Tengri's unreferenced
`prepared/` directory, so merging source cannot invalidate the current controller's production API before cutover.
