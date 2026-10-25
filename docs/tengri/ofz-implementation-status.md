# Ofz implementation status

The current backup destination is the [Ceph recovery store](../../services/ofz/recovery.md). The October 25 migration
retires the NUC store for Ofz and Keycloak; the NUC qualification notes below are historical evidence, not active configuration.

The migration is incomplete. The delivery target is [the enterprise authorization plan](ofz-enterprise-authorization-plan.md),
including deployed allow/deny/revocation, failure and failover checks, independent restore and the required soak.
Work proceeds directly, without subagents, through the existing native GitHub stack. Historical decisions and detailed
fixture evidence remain in [the implementation trail](ofz-implementation-decisions.tsv).

## Historical release boundary

The active source frontier is encrypted independent recovery on `codex/ofz-recovery-encryption`.
The dedicated identity source merged in [#15038](https://github.com/proompteng/lab/pull/15038) at
`7b520e8d8827b9fb4d32e9a9f4503763579a25a1`, after every exact-head check passed and its actionable review was resolved.
Keycloak and Cloudflare retain their existing workloads, with reconciliation temporarily paused until independent
backup/restore permits the coordinated identity rollout. Ofz reconciliation is also paused until a successfully
published image produces its first reviewed `kargo/ofz` commit. Its initial main-source migration hooks attempted the
inert `unpromoted` reference and did not execute. The control databases exist; the owner schema/bootstrap and serving
API still require the image release. The retired native key is denied, and both old Tengri native types have zero
relationships, so installing the new schema does not require retaining old grants.
The fenced API/exporter and approved owner bootstrap merged in [#15026](https://github.com/proompteng/lab/pull/15026)
at `971f5874970c7ce5453bff0f11a8cb822c03740f`. Its exact-head validation and both image builds pass; main image
publication and the Kargo/Argo rollout are pending. The live registry is stopped during a filesystem check of its
detached RBD volume. Preserve that recovery hold until its owner completes the check.
The Keycloak configuration now has one active GitOps source, with the obsolete prepared overlay removed. Its dedicated
realm credentials, verified issuer certificate and tunnel route, two serving replicas and three host-spread database
instances pass the real API-server dry run. The exact database toleration admits the third host without removing
Ryzen's compute-local taint. Five rendered targets and thirty-one rejected regressions pass. The real Keycloak 26.7.4,
Chromium, BFF, controller, Ofz and SQL fixture passes all eighty-one assertions in 81.84 seconds. This is isolated
evidence; independent backup/restore, live deployment, the real OAuth callback switch and passkeys remain pending.

The NUC encryption preflight reproduces a failed encrypted upload because the earlier server has no wrapping key.
The correction persists and fingerprints one key, supplies it through a private file, enables bucket encryption,
and requires encrypted version readback before SQL acknowledgement. The prior exporter fails the new unencrypted
version regression; the corrected full archive/bootstrap fixture passes three tests in 22.644 seconds. It proves
eight-MiB multipart encryption, absence of the plaintext marker in the backing files, crash/restart readback,
immutable retention and key-loss/corruption rejection. This change is locally qualified and not deployed. NUC SSH
currently refuses the existing agent signature; the owner has been asked to unlock that agent again.
The independent archive merged in [#15020](https://github.com/proompteng/lab/pull/15020) at
`1d2b782014a4f76d3dc3bd25095d4b0e163b6cd6`. Its main image is published and its NUC service is deployed and verified.
The owner-only bootstrap/activation commands merged in [#15014](https://github.com/proompteng/lab/pull/15014) at
`3b78559173e6a5dd25b514f28a12b08bacfe0a9f`. Automatic review found that expected relationship checks permitted surplus
native authority. The correction merged in [#15016](https://github.com/proompteng/lab/pull/15016) at
`300b190c4e131dd37864c7c8fdece5aed4a8709c`. It requires the complete platform relationship set to match the approved
manifest and workload bindings, including during final activation. The P1 thread is resolved. Publication and
production activation remain separate gates.
Its protocol dependency, [#14923](https://github.com/proompteng/lab/pull/14923), merged at
`3825ddf2e933bade9a9fb16641ac77c7ccf14fe0` after its exact published head passed every check with no unresolved review
findings. Its paired main images pass native KVM acceptance on both architectures in run `38491598949`.

The native corrections resolve main run `38477121352`'s stale identity assertion and destructive disk-probe ordering.
Both new receipts confirm three sleep/resume cycles, file and same-shell continuity, initialized Codex, browser
startup, reported disk EIO and continued responsiveness. The amd64 prepared creation is 700.75 ms and maximum sampled
resume is 583.73 ms; arm64 is 966.69 ms and 923.18 ms. These are smoke samples, not a p95 creation/resume distribution.
The 50-cycle run `38501167488` failed on arm64 at the unchanged Neovim first-screen limit: 1115.80 ms exceeds 1000 ms.
Its source is `c024a1f03b2b7c80cc81a5f2cacda22054b83b5b`, whose runtime, guest, authorization protocol/catalog,
native workflow and seccomp inputs match the qualified protocol-4 source. Amd64 completed all fifty resume samples
with a 757.53 ms p95 and 1454.16 ms maximum; its single creation took 629.46 ms. These results do not establish a
fresh-creation distribution or authenticated frontend performance. Arm64 sustained performance remains unqualified.
The NUC smoke remains a failure: its 1776.95 ms creation and 1009.11 ms Neovim first screen exceed unchanged limits.
That fixture stopped before the destructive disk probe, cleaned its resources and restored its previous fixture tag.

The 2026-10-13 live readback uses `galactic-tailscale`. Ofz has three SpiceDB replicas and two Playground replicas,
with three PostgreSQL Pods. There is no Ofz API Deployment and there are no Tengri MicroVMs. The
`tengri-ofz-cutover` admission binding remains active. The obsolete controller has been stopped, and its Argo
Application is temporarily paused with `argocd.argoproj.io/skip-reconcile=true`. Resume reconciliation only against
the replacement Kargo commit. The six old unclaimed slot Pods, home PVCs and Leases are verified absent. The repository release variable
`TENGRI_PREPARED_SLOT_CUTOVER_READY` remains `false`.

The owner explicitly authorized deletion of the old workspaces and homes. That deletion is complete; retained-data
import and migration rehearsals are superseded. The old unclaimed prepared pool and its home journals are retired.
Activate only the new VMM/protocol. Fresh workspaces must use the final contract. No legacy authorization fallback is implemented.

## Service delivery

| Service or contract                                                               | Source delivery                                                | Remaining release boundary                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Ofz lifecycle, quotas, durable policy commands, audit and admission               | #14908 merged                                                  | Bootstrap, independent exporter, delivery enrollment and API activation |
| Tengri controller, runner and supervisor; Landing lifecycle and desktop authority | #14915 and #14916 merged                                       | Coordinated activation and fresh-workspace browser proof                |
| Replicated Ofz, Keycloak and application configuration                            | #14909 merged                                                  | Live host loss and three-node CNPG qualification                        |
| Physical database promotion                                                       | #14910 merged                                                  | Native CNPG and independent restore                                     |
| Allocation/runtime epoch and preview binding                                      | #14911 merged at `fe2acf427ab4ec53733a4960fc9af1d5f67e8727`    | Coordinated runtime/guest activation                                    |
| API image factory                                                                 | #14985 merged at `844d149ff29dc884290e19241645926d8cee3bda`    | Warehouse/Stage enrollment and API deployment                           |
| Signed guest and preview admission                                                | #14913 merged at `9bb95305b8dc72e7465fba35de6998714168a37b`    | Native performance, independent execution fencing and activation        |
| Explicit Viewer scopes                                                            | #14920 merged at `70b513e03287b33af582520bb21671f4a99e92c2`    | Bounded observers and coordinated activation                            |
| Viewer administration UI                                                          | #14921 merged at `936489dd651c5896ba35abc47ab1065eb479d49c`    | Deployed UI acceptance                                                  |
| Exact-target protocol 4                                                           | #14923 merged at `3825ddf2e933bade9a9fb16641ac77c7ccf14fe0`    | Fifty-sample qualification and coordinated activation                   |
| Initial administrator bootstrap and activation                                    | #15014 and #15016 merged                                       | Protected inputs, independent archive and production activation         |
| Independent immutable audit archive                                               | [#15020](https://github.com/proompteng/lab/pull/15020), merged | Kubernetes exporter adoption and full recovery qualification            |
| Bounded file observers                                                            | Local implementation, unpublished                              | Finish controller/BFF wiring and full scoped acceptance                 |

The latest verified API factory receipt is main run `38521111594`. Its two-platform index is
`registry.ide-newton.ts.net/lab/ofz@sha256:23168c8fc76893a4bd9313d221045a4fe8b39b316dd0a5d7338ec143d28a2d03`,
with immutable alias `kargo-sha-1d2b782014a4f76d3dc3bd25095d4b0e163b6cd6-run-38521111594`.
The exact reviewed source archive and this image initialized the NUC service. Local S3 proof rejects writer/root
version deletion and retention shortening. A separate Mac tailnet peer verifies native TLS 1.3, exact certificate
identity, version-specific object readback and denied writer deletion. The same immutable version, SHA-256 and
retention survive an actual server SIGKILL/restart. The existing six unrelated NUC containers remain running;
Serve ports 443, 8090 and 8100 retain their original routes. This proves independent archive storage and TLS,
not Kubernetes exporter adoption, independent database/home restore or the final Tengri cutover.

## Current isolated evidence

- The new archive fixture passes against real TLS PostgreSQL, the owner CLI and versioned S3 in 24.50 seconds.
  It uses the production credential generator and writer policy, and SQLite WAL/FULL with synchronized object writes.
  Archive acknowledgement gates real bootstrap activation. It proves interrupted upload recovery, out-of-order
  audit commits, writer/root version-deletion denial, retention-shortening denial and process-crash readback using the
  same disks and client endpoint. Corrupt payloads, short retention, weak defaults and archive loss immediately invalidate health without acknowledging pending rows.
  Receipt timestamps newer than the clock snapshot retain a full ninety days; oversized aggregate batches split
  without dropping or acknowledging omitted receipts. Both defects reproduce before their corrections.
  The NUC service now has the live storage/TLS/crash evidence above. Kubernetes exporter adoption remains pending.

- The surplus-platform-authority regression fails before the correction. The corrected real bootstrap fixture rejects
  an unapproved administrator, a cross-role workload binding, a retired platform and authority added during the final
  activation check. The fence and SQL version remain unchanged. Eleven units, Clippy and the full 81-assertion browser
  identity fixture pass; the browser fixture takes 78.39 seconds.
- The owner-only bootstrap/activation continuation passes eleven Ofz units, Clippy and the actual CLI against real TLS
  PostgreSQL and SpiceDB. It rejects an API-role caller, existing unapproved control state, changed input/schema and
  a corrupted stored manifest. DDL and its mandatory checksum are atomic across cancellation; a null checksum is
  rejected without repair. Interrupted native initialization recovers with its original receipt. Activation remains
  fenced during archive loss, including loss while its audit insert or final native check is blocked. Completed retries cannot undo later
  offboarding or a generation-2 recovery fence. Both integrity and final-archive guards have failing regressions when
  removed. Fixture acknowledgements are explicitly synthetic; independent archive installation remains required.
- The final atomic-migration source passes the full real browser identity fixture with 81 assertions in 78.43 seconds.
- The continuation's NUC control/promotion proof passes 55 commands and 174 immutable receipts. Its synchronous
  physical promotion recovers unchanged clients in 3.28 seconds and preserves the unexpired consumed nonce, tickets,
  previews and current policy. The fingerprint enumerates every control table from one snapshot, including the new
  bootstrap journal, with a minimum of nineteen tables. A local Docker attempt failed during initial TLS pool creation;
  the corresponding NUC proof passes without increasing production timeouts.

- Signed admission passes 142 macOS runtime tests, three CRD tests, eleven signed contracts and Clippy. Go race/vet,
  native Linux guest checks, deterministic cross-language vectors and real Rust/Go RPC/SPIFFE interoperability pass.
- All 26 shared-runtime SQL tests pass locally and on NUC. The NUC full run takes 81.81 seconds. Earlier remote capacity
  failures were intermittent and their connection cause remains unconfirmed. Pool errors now retain internal context.
- Both terminal controller failures reproduce before the sub-operation correction. Admission now requires the original
  controller operation and an independently authorized exact guest action/target, with its own receipt and a deadline
  bounded by the parent. The proof covers terminal tickets/termination, Codex resume and image staging. Either permission
  alone, a changed workspace or a changed runtime cannot authorize the compound operation.
- The replay store accepts a verified five-second request when its clock lags by 500 ms. The SQL future bound allows
  one second of clock lead; signed five-second deadlines, exact expiry, replay and excessive-future denials remain intact.
- The maintenance archive race reproduces an allowed response carrying an immutable denial receipt. The correction
  compares final archive and fence state and records a terminal denial before aborting changed authority. Four real
  audit-lock races cover both directions of each flag. The full control fixture passes 50 commands and 141 receipts.
- Real Chromium, production Keycloak 26.7.4, Ofz, SPIFFE and SQL pass 60 assertions after the maintenance correction.
  Ofz serving-process loss preserves the session. Keycloak loss during a passkey challenge recovers within 30 seconds.
  These checks use synthetic GitHub identities and virtual passkeys.
- The Viewer policy continuation, rebased onto the maintenance correction, passes nine Ofz unit tests, Clippy and
  55 real control commands with 174 immutable receipts. Both pending-scope and in-flight narrowing regressions pass.
- The current Viewer UI passes 342 BFF/component tests, TypeScript, lint and 81 real browser assertions.
  It verifies metadata-only defaults, inline rejection before identity lookup, exact scopes, new-subject consent,
  narrowing, screenshot consent and content removal without starting the workspace. Encoded commands must fit the
  existing 64 KiB request budget, including escaping and metadata. Three regressions reproduce the prior size mismatch;
  the browser now rejects an oversized scope inline without an identity lookup or policy change.
  An accepted 64 KiB command also reproduced a late 429 from the private gRPC envelope caps. Both sender and decoder
  now allow 128 KiB envelopes; the real BFF-to-Ofz boundary command commits and its scope can be removed afterward.
  The browser also reproduces the old form's trimming of a whitespace-bearing file root, thread ID and terminal ID.
  Target splitting now preserves each nonempty line exactly; the complete fixture passes with those literal targets.
  The roster labels and quotes each target kind, distinguishes identical thread/terminal IDs, and does not advertise
  browser access on metadata-only diagnostic grants. Invalid Unicode that protobuf would replace is rejected.
  CI exposed a preview fixture reusing an expired context after earlier operations. It now creates a fresh five-second
  context at preview submission; production deadlines and the expired-submission denial remain unchanged. The latest
  combined browser proof passes after this correction, alongside 142 runtime units, three CRD tests and eleven contracts.
- The prepared protocol-4 continuation passes Rust units/contracts, Go race/vet on macOS and native Linux, real RPC/SPIFFE
  interoperability, deterministic vector parity and 26 shared SQL tests. The latest rebase passes 142 runtime units,
  three CRD tests, eleven signed contracts, Clippy, macOS Go race/vet, real Rust/Go RPC/SPIFFE interoperability and all
  26 shared SQL tests on NUC in 70.86 seconds. Local Go uses 1.27.1; native CI retains the pinned 1.25.5 toolchain.
  Ofz retains the full scope; signed guest proofs carry one exact authorized target and output budget. Retired
  protocol-3 proofs remain rejected.
- Earlier physical promotion recovers unchanged clients in 2.84 seconds, preserves the unexpired consumed nonce and
  matches all 18 control-table hashes. The complete prepared HA renders validate 65 resources and reject 15 regressions.
  These isolated proofs do not establish deployed CNPG recovery or an independent restore.
- Demand-paged snapshot advice reduces sampled first-resume reads from 347 MB to 27 MB. Three functional NUC cycles
  preserve files, Codex, the terminal and zero-RAM sleep. Creation at 1.66 seconds and maximum resume at 1.24 seconds
  still fail the unchanged one-second target. Both native architectures, fifty-sample qualification and live acceptance
  remain required.
- The PR cache policy passes Actionlint and 57 routing/release contract tests. Same-repository PRs use separate
  `cache-pr-<number>-<architecture>` tags per service. Main retains its own cache. The first Nanoagent cache exports
  took about 25.5 minutes per architecture. Exported registry manifests are verified. A subsequent #14921 ARM64 Tengri
  build with unchanged Rust sources completed in 2m4s using the PR cache; the next Rust fixture change required a full
  compilation. This does not establish a controlled performance benchmark or eliminate source rebuilds.

## Remaining implementation and cutover

- [ ] Complete bounded Files, Terminal, Codex, Browser and Preview observation through controller, BFF and guest handlers.
      Prove zero guest side effects, output budgets and timely revocation on every channel.
- [ ] Add an independent host execution deadline and prove guest/egress fencing within thirty seconds of authority loss.
- [ ] Complete proof-bound diagnostic credentials, shared DPoP replay, the agent adapter and restricted diagnostic routes.
- [ ] Deliver dedicated native Kubernetes RBAC and the scoped broker; verify effective permissions and real denied requests.
- [ ] Deliver the reviewed connector catalog, target/credential controls, destination validation and response budgets.
- [ ] Complete IdP offboarding, copied-credential rotation and clean-environment recovery for quarantined homes.
- [ ] Install independent immutable audit, database/home backups and restore on the approved NUC destination.
- [ ] Publish and qualify the owner-only bootstrap/activation commands; install the protected approved input and
      complete both custodians' real passkey enrollment.
- [ ] Enroll API/broker delivery, supply required credentials and activate the reviewed final contract through Kargo/Argo.
- [ ] Verify exact commits, images, schema and configuration; remove the creation fence only after cutover gates pass.
- [ ] Prove fresh-workspace product behavior, every service's allow/deny/revocation/failure matrix, independent restore,
      both native performance targets and the required mixed-workload soak.

## Creation failure found during cutover

The live frontend/controller still report image revision `26bfce8ec1221e6df85c6f45fb525ab98277bf50`.
Their creation shape requests 2000 CPU millis and 4096 MiB, while the installed CRD accepts only 4000 and 8192.
A server-side dry run reproduces both rejected resource values without creating a MicroVM. A second dry run using
the new resource shape is denied by `tengri-ofz-cutover`. The deployed BFF maps both Kubernetes 422 failures to
“Tengri request is invalid.” The corrected four-core/eight-GiB labels are prepared for the coordinated frontend release;
the controller, guest, schema and identity dependencies still require the coordinated release before creation resumes.
