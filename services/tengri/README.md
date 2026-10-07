# Tengri control plane

Tengri owns `runtime.proompteng.ai/v1alpha1 MicroVM` resources and six prepared Firecracker slots. Every guest has
4 vCPU, 8 GiB RAM, a private 1 GiB root disk, and a retained 16 GiB Ceph home. Creation restores a prepared snapshot;
resume restores that owner's latest committed snapshot. Neither request schedules a Pod, attaches storage, boots a
kernel, or installs tools. Empty or preparing capacity returns an explicit error.

Sleep freezes and snapshots the guest, flushes its disks, stops and reaps the VMM, and evicts the snapshot's file pages
before acknowledging completion. The stable slot Pod, home PVC, TAP, and small host supervisor remain. Kubernetes
resource requests still reserve resume capacity even while resident guest RAM is released.

This source uses one runtime. The previous Kata Pod lifecycle and guest SPIRE/token-refresh implementation are
removed. The hard cutover is separately authorized and must preserve existing home PVC UIDs. Source and local tests
do not establish a deployed migration or the authenticated p95 latency target.

## Slot ownership and failure handling

Each slot has a Kubernetes Lease and one private Pod. `MicroVM.spec.slot` records the slot, Pod UID, home name/UID,
and epoch. The controller binds the MicroVM with resourceVersion compare-and-swap before claiming the Lease. Concurrent
claims cannot assign two slots to one MicroVM UID or start two owners in one slot. Deletion before a Lease claim
consumes the candidate epoch with the same Lease CAS, preventing a late claim while retaining the unused prepared slot.

The runner's durable journal binds the Pod and home UID, guest image, kernel digest, Firecracker 1.16.1, CPU identity,
snapshot generation, and owner/epoch. Snapshot restore consumes the generation before vCPUs run, then thaws root/home,
sets the guest clock, binds the owner, and checks files, a PTY round trip, and initialized Codex. A failed save may resume
only the still-live guest. Older memory is never restored against disks that may have advanced.

Loss of an active runner, Pod, or node retains the owner and home for explicit fenced recovery. Lease age, missing
Pods, and controller disconnection never authorize a replacement writer. Sleeping journals can reopen only with
unchanged runtime and disk identities. An exited VMM fences traffic and reports failure.

Deletion persists proof of VMM termination before deleting the slot Pod, then removes only matching assets with UID
and resourceVersion preconditions. A retry after Pod deletion uses the durable receipt. No stop proof means no disk
or finalizer removal. A replacement slot always gets a fresh Pod, home, token, and snapshot. Image updates recycle
only unused slots; claimed guests retain their runtime through ordinary sleep/resume.

## Host and guest boundaries

The slot runs under the normal OCI runtime with separate container PID namespaces, no host networking/mounts,
and no Kubernetes API token. The supervisor mounts only the SPIFFE CSI socket and private control sockets. The runner
mounts only its boot artifacts, disks, token, and sockets.

The short-lived TAP init container receives NET_ADMIN inside the Pod network namespace. It creates `tengri0`, private
10.250.0.0/30 addressing, NAT, and protected-destination filtering. It asserts CNI forwarding is already enabled and
never changes node sysctls, routes, bridges, scheduling, or machine configuration.

The runner briefly starts as root with MKNOD/SETUID/SETGID. It creates a private device inode in its container's `/dev`
for the allocated raw home device, then drops to UID/GID 65532 with no effective, permitted, inheritable, or ambient
capabilities. It never chmods a node device. Firecracker inherits that unprivileged identity, no environment secrets,
no capabilities, NoNewPrivs, and its default seccomp filter.

The separately reviewed [device allocation](../../argocd/applications/tengri-devices/) delegates only KVM and TUN
through the official generic device plugin. The platform ApplicationSet enrolls it in `kube-system` at wave 1, before
the controller's wave 2. Verify actual device allocations before an authorized cutover. The existing namespace admission
already permits this narrowly constrained profile; no namespace policy change is required. Existing guest SPIRE
attestation and bundle publication remain until the final old guest has stopped.

Nanoagent runs as UID 1000 in the guest, with passwordless sudo inside that guest. Guest root edits and processes
survive snapshot sleep. Root and memory are local to the slot Pod and reset after an explicitly fenced cold replacement;
the home PVC remains the durable boundary. No guest process receives the host Workload API socket or host identity.

## Transport and workload identity

Browser requests enter the authenticated BFF. The BFF signs owner-scoped gRPC requests to Tengri with replay protection.
SPIRE mTLS authenticates both host hops. Tengri's identity is `spiffe://proompteng.ai/ns/tengri/sa/tengri`; its port 50051
accepts only `spiffe://proompteng.ai/ns/proompteng/sa/proompteng`. Every slot supervisor has
`spiffe://proompteng.ai/ns/tengri/slot/pod/<Pod UID>` and accepts only Tengri. Certificates rotate outside guest memory.

The supervisor serves mTLS port 8443 and requires the exact MicroVM UID/epoch before forwarding files, terminals,
Codex, previews, or editor content over vsock port 1024. Nanoagent additionally validates the unique slot credential.
Lifecycle commands use a private host Unix socket; guest freeze/resume uses separate vsock port 1025. Guest health
binds only loopback port 8080. Supervisor health on host port 8080 never dispatches guest RPCs.

The [NanoagentService contract](proto/proompteng/runtime/guest/v1/nanoagent.proto) carries unary operations, server
streams, and the bidirectional terminal stream. Tengri translates terminal frames into browser WebSockets; application
and editor previews retain HTTP/WebSocket proxying. Rust bindings are generated by build.rs. Regenerate committed Go
bindings with `bash services/nanoagent/generate-proto.sh`. `bash services/tengri/test-rpc-interop.sh` exercises the real
Rust/Go wire protocol, exact peer rejection, and SVID renewal.

Terminal creation has one protocol: every client supplies a stable 16-to-128-character `creation_id`, and Nanoagent
returns that exact identity with the session. Retries reuse the same identity and are idempotent. Tengri rejects
id-less requests instead of generating a compatibility identity or negotiating with an older guest.

Pending Codex device logins are guest-owned. A reconnecting desktop reads the active attempt from Nanoagent and keeps
the same verification code and original expiry instead of silently starting and invalidating another attempt.

Workspace file reads return bounded protobuf bytes and a required strong SHA-256 revision. Tengri verifies that the
revision matches the content and rejects missing, malformed, or mismatched revisions. Writes require a lowercase
64-character SHA-256 `expected_revision` or `missing` for create-only writes; malformed preconditions fail before
contacting the guest. Nanoagent reports stale writes as `ABORTED` with the current revision. Successful writes return
the new path, size, and revision.

Paginated Codex conversations resume with `excludeTurns: true`, then load `thread/items/list` and metadata-only
`thread/turns/list` in ascending pages. Each item carries the event cursor captured with its page; the desktop uses
that cursor to discard covered replay while retaining updates that arrive after an earlier page. The initial resume
cursor remains the baseline for new items. Retrieval is bounded to 90 seconds, 256 pages, and 10 MiB, and any failed
page fails the restore instead of displaying incomplete history. Threads explicitly marked `legacy` retain the
single full-history snapshot and cursor contract required by their reconstructed item identities.

The guest pins Codex 0.159.2 in `services/nanoagent/bootstrap-codex.sh` so ChatGPT-backed guests can use
`gpt-6.1-sol`. Its generated item-page schema returns `{ turnId, item }` entries, not bare items. The independently generated `packages/codex` SDK is not the guest
protocol authority. Verify changes against the pinned binary with
`codex app-server generate-json-schema --experimental --out <temporary-directory>`.

Each Chrome preview load exchanges its one-use ticket for a bounded, owner-scoped session whose ID is allocated before
the browser receives the ticket. The desktop revokes both unused tickets and active sessions when a preview is
superseded or closed, so reload and history use cannot exhaust the per-agent session limit. The gateway injects a
nonce-authorized navigation bridge into uncompressed HTML responses; the desktop accepts navigation and shortcut
events only from the exact issued preview origin and iframe. This keeps the virtual address bar, history, reload, and
Chrome shortcuts synchronized without exposing the session token to guest applications.

Public HTTP traffic is split across two listeners with separate routers and Kubernetes Services. Port `8080` exposes
only Tengri-owned control routes such as terminal WebSockets, preview-session opening, probes, and metrics. Port `8081`
exposes only session-host bootstrap assets and the authenticated guest preview proxy. Traefik routes
`tengri.proompteng.ai` control paths to `tengri-gateway:8080` and session hosts to `tengri-preview:8081`; observability
can reach only the control listener. A guest application may therefore own paths such as `/metrics` or `/healthz`
without those requests reaching Tengri's own handlers.

`/livez` reports process liveness. `/readyz` and the compatibility `/healthz` alias report success only while the
Kubernetes control path, SpiceDB permission API, and in-process ticket state are usable; deployment probes do not advertise an isolated process
as ready to accept agent operations.

## Workspace authorization

The Rust controller uses the shared [Ofz SpiceDB service](../../argocd/applications/ofz/README.md).
[`src/authz.zed`](src/authz.zed) defines `tengri_user`, `tengri_workspace`, an `owner` relationship, and
`access = owner`. The user ID is the existing SHA-256 GitHub subject hash; the workspace ID is
`<namespace>/<MicroVM name>`. Each workspace operation checks `access` with fully consistent reads. Local CR owner
fields and labels supply initial enrollment metadata; they do not authorize a request.

`TENGRI_AUTHZ_ENDPOINT` and `TENGRI_AUTHZ_KEY_FILE` are required. The deployment connects to
`http://ofz.ofz.svc.cluster.local:8443` and mounts `tengri-spicedb-key` only in the controller. Requests read the
projected key file each time so Secret rotation takes effect without a restart. The key permits the whole SpiceDB API;
the browser, BFF, and guest never receive it. NetworkPolicy permits only the controller to reach Ofz's SpiceDB pods.

Before serving, startup installs the embedded schema only when SpiceDB reports no schema. An existing schema is
preserved and must already contain the Tengri definitions; a missing or incompatible permission contract stops startup.
Future changes to the shared schema require an explicit reviewed migration. Startup enrolls existing non-deleting
MicroVMs using their recorded owners. Creation enrolls new workspaces before returning success. Enrollment records
`runtime.proompteng.ai/spicedb-enrolled: v1` on each CR after writing the relationship. Kubernetes status/finalizer write
conflicts retry the annotation patch without repeating the grant. Interrupted enrollment is retried before the
workspace is returned successfully.

The marker prevents subsequent startup or repeated creation from restoring a revoked owner relationship. Keep the
annotation when managing grants. To revoke a workspace, delete its `owner` relationship through the private SpiceDB
API. Grant changes take effect on the next request. Open file/Codex streams and terminal/preview WebSockets recheck
access every second and close on denial or authority failure; streaming preview response bodies use the same guard.
Permission requests have a two-second deadline. Denial returns `PERMISSION_DENIED`; outages or invalid responses return
`UNAVAILABLE`. There is no local authorization fallback or positive permission cache. Deletion removes all workspace
relationships before deleting the guest resources and releasing the finalizer.

Run `bash services/tengri/test-authz.sh` to test schema installation, enrollment with a Kubernetes write conflict,
owner and foreign-user checks, namespace isolation, stream revocation, restart without re-granting, and preservation
of another application's schema against the pinned real SpiceDB image. It creates and removes an isolated local
Docker container and uses only a disposable test key. Both controller and image CI gates run this test.

`TENGRI_INTERNAL_HMAC_SECRET` normally contains one base64url key of at least 32 bytes. Rotate it without an
authentication outage by sealing `new,current` into both namespace-scoped manifests in the same commit: the BFF signs
with both keys and the controller accepts either while the two SealedSecrets reconcile independently. After both
workloads observe the bundle, reseal both manifests with only the new key. More than two keys are rejected.

The Deployment also mounts `tengri-runtime` as a projected Secret. Tengri compares those files with the values loaded
into its environment and, without logging either value, deletes only its own control-plane Pod when the SealedSecrets
controller updates the generated Secret. The Deployment then creates a replacement Pod with the refreshed environment;
no manual restart or cluster-wide reloader is required.

Every valid signed request atomically consumes a hashed replay receipt in the pre-provisioned
`tengri-auth-nonces` ConfigMap. Kubernetes `resourceVersion` compare-and-swap makes replay rejection consistent across
controller restarts. The singleton serializes nonce updates before entering the Kubernetes compare-and-swap loop, and
bounded exponential retry absorbs an external write conflict without rejecting an ordinary burst of valid requests.
Only live receipts are retained and the bounded store fails closed. The deployment RBAC grants only `get` and `update`
on that named ConfigMap.

## Lifecycle settings and delivery

System Settings → Lifecycle controls `spec.power.idleTimeoutMinutes`. The default is 60 minutes, values through 1440
are accepted, and zero disables automatic sleep. Manual sleep always releases resident guest RAM. Changing the timeout
starts a new idle interval; authenticated activity extends it. Retained homes have no expiry or automatic deletion deadline.

The authorization cutover requires the Ofz service, its existing API key, the controller-only NetworkPolicy rule,
and `tengri-spicedb-key` before the new controller starts. The committed strict-scope SealedSecret is generated with
`nix develop -c python3 scripts/seal-tengri-authz.py --context galactic-tailscale`; the helper reads the existing Ofz key
and writes ciphertext without applying resources. Rotate this copy whenever the shared Ofz key changes. Validate the
sealed manifest, render the Tengri application, and publish/promote the reviewed controller image through Kargo.
Verify exact deployed revisions, enrollment annotations, allowed and denied workspace operations, and open-session
revocation after an authorized rollout. Preserve SpiceDB's PostgreSQL data and the enrollment annotations during
recovery; do not clear them to recover an intentionally revoked grant.

Normal delivery uses the paired image publisher, Kargo, and Argo. Native AMD64/ARM64 guest artifacts contain the
checksummed kernel/root disk. The controller image also supplies the host runner, supervisor, TAP script, and pinned
Firecracker. Keep the paired source revision and immutable image digests together. Withhold discoverable Kargo aliases
until real KVM acceptance passes. See the [operations runbook](../../docs/tengri/operations.md) for the permission
review, retained-home enrollment, release boundary, and recovery procedure. Do not run historical node-mutating spikes.

## Validation

```bash
cargo fmt --manifest-path services/tengri/Cargo.toml --check
cargo clippy --manifest-path services/tengri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/tengri/Cargo.toml --locked --all-targets
bash services/tengri/test-rpc-interop.sh
cargo run --manifest-path services/tengri/Cargo.toml --locked --quiet --bin crdgen > /tmp/tengri-crd.yaml
diff -u /tmp/tengri-crd.yaml services/tengri/crd.yaml
diff -u /tmp/tengri-crd.yaml argocd/applications/tengri/crd.yaml
shellcheck services/tengri/network.sh services/tengri/test-kvm*.sh
```

The ignored Linux KVM test requires explicitly authorized device grants and native paired boot/test images.
The AMD64 PR image jobs retain `tengri-kvm-fixture-tengri-amd64` and
`tengri-kvm-fixture-nanoagent-amd64` artifacts. Download both from the same workflow run and merge their contents into
one directory. Check both `*-SHA256SUMS` files there, then load both `*-images.tar.gz` archives with `docker load`.
The JSON receipts record the PR head, checked-out build revision, image reference, and saved image configuration digest.
Verify that both receipts match the requested PR head and build revision, and that the loaded configurations match
`configDigest`. Docker's containerd image store can report an image index as its image ID; the configuration digest
remains the same after loading the archive into a classic image store.
CI builds these artifacts without executing the KVM fixture. It requires no SSH devbox. Device execution still
requires the scoped approval below.
`TENGRI_KVM_TEST_IMAGE`, `TENGRI_KVM_GUEST_IMAGE`, `TENGRI_KVM_OUTPUT`, and `TENGRI_KVM_SAMPLES` select the artifacts,
absolute local result directory, and sample count for `bash services/tengri/test-kvm.sh`. It uses a private Docker
network/PID namespace, one CPU, 9 GiB memory, only KVM/TUN and startup NET_ADMIN/SETUID/SETGID, and no host data mounts.
It checks real files, the same PTY shell, initialized Codex, stop/page-eviction, and rotating host identities, preserving
diagnostics before cleaning only its own resources. Its report states the boundary and exclusions. One prepared
creation and repeated slot resumes do not prove the full authenticated BFF/Kubernetes creation distribution or six
concurrent guests.

## Editor sessions

`IssueEditorSession(agent_id, window_id)` authorizes the owner, starts the guest workbench, and returns an ordinary
preview launch ticket for virtual port 13337. Its DNS-safe origin derives from owner, agent, CR UID, and desktop window
identity, so reload restores the native workspace and backups while another owner, incarnation, or window gets another
origin. Session cookies expire after 24 hours. The one-use launch token is also the revocation generation: a delayed
cleanup cannot revoke a replacement session on the same origin. Generic preview revocation retains its existing behavior.
Before sign-out clears authentication, `RevokeEditorSessions` removes every pending and active editor lease for the
authenticated owner. A revocation failure blocks sign-out so it can be retried. The gateway also closes established
preview WebSockets within one second of session revocation or expiry.

The gateway injects the desktop integration script only into the workbench document. Native Markdown and extension
webviews retain their own HTML and CSP; editor frame ancestors allow both the issued origin and desktop origin.
Packaged assets under an exact upstream revision are compressed and privately cached. Workspace resources, HTML,
tickets, and integration scripts remain uncached. The private extension bridge binds its session query to the
cookie-authenticated preview origin. Ordinary preview sessions cannot select either reserved editor port.

Codex `SendCodexInput` and `SteerCodexInput` RPCs accept text, PNG/JPEG/WebP image bytes, or both.
These replace the former turn-input RPCs. A controller with the old contract rejects the new RPCs before
starting or steering a turn, preventing silent image loss during a mismatched release. Image inputs are limited to four,
4 MiB each, and 8 MiB total. Tengri verifies media signatures, writes the images into the owned retained guest
under `/workspace/.tengri-attachments` through gRPC, and submits Codex `localImage` inputs. A failed image write
fails the request before Codex starts or steers a turn. Attachments remain with the persistent workspace so saved
conversation references remain valid.
If a batch write fails, Tengri attempts to remove its unsent files, including a partially committed failed write.
Create-only conflicts preserve the existing file. Cleanup failures are logged while the original upload error is retained.
