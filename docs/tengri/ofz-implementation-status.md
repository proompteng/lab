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
restacking onto current main. Native Linux builds supplied the dependency hashes for both architectures; corrected
hashes still require successful image builds. Real custodian
enrollment and deployed product proof remain later gates.

The coordinated cutover gate also covers the Proompteng image: Kargo discovery remains withheld while
`TENGRI_PREPARED_SLOT_CUTOVER_READY` is false. This was verified against the repository variable and workflow input;
the production BFF remains on its previous image. Rate limits use the connection peer, so clients reaching the
LoadBalancer cannot choose buckets with proxy headers. Tunnel clients share the tunnel Pod's bucket. An isolated
Traefik 3.7.13 fixture on NUC reproduced seven admitted requests with rotating headers under the previous configuration
and returned HTTP 429 on the seventh request under the corrected configuration. This is isolated ingress proof;
production ingress acceptance remains part of P8. Fifty-seven focused inventory, rollout and ingress checks pass.
The enabled-app inventory follows declared nested Kustomize inputs, excluding prepared directories until referenced;
only Ofz's classification changed in the current repository inventory.
