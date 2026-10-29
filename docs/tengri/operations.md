# Tengri operations

## Latency diagnosis

Scrape the controller Pods individually. A Service-backed target combines independent process counters and cannot
provide a valid rate or distribution. `/metrics` remains available when dependencies fail; inventory is the last
successful readiness observation, not current authority. Check `tengri_inventory_last_success_timestamp_seconds`
and `tengri_inventory_age_seconds` before using guest or ticket gauges. A zero last-success value means no inventory
has been collected. `tengri_readiness_failures_total` distinguishes authorization, database, and Kubernetes errors
from timeouts without exposing identities.

Use the boot/resume histograms for CR-create/persisted-intent to Ready latency, not authenticated browser latency.
The one-second p95 alerts require twenty successful observations in fifteen minutes; failures remain visible in
readiness/guest counters and traces rather than being reported as successful startup samples. The existing native
KVM test excludes BFF admission and six-guest contention. Full product qualification must measure authenticated
creation/resume through a file read, PTY round trip, and initialized Codex response, with failure counts and the
same resource profile on both sides of any comparison.

For slow run status, compare `tengri_run_status_seconds` and `tengri_active_runs_seconds` with the BFF root trace.
For Ofz, inspect `db.audit.batch` queue-wait/batch-size fields and its `db.audit.pool.acquire`, `db.audit.begin`, and
`db.audit.commit` children. PostgreSQL 18 exposes WAL write/fsync timing in `pg_stat_io` when `track_wal_io_timing`
is enabled. Compare counter deltas over the same window and inspect synchronous standby lag; cumulative means do
not establish a current p95. Do not remove audit commits, fresh policy checks, or synchronous replication to improve
latency. Keep storage migrations and shared-node changes separate from this application rollout.

Tengri uses six prepared Firecracker slots under the normal OCI runtime. Each has a host supervisor, unprivileged VMM
runner, Pod-local TAP, private snapshot/root disks, and a retained 32 GiB Ceph raw-block home. Source behavior is defined
by [the service README](../../services/tengri/README.md) and [slot code](../../services/tengri/src/slot/).
The [KVM/TAP design](kvm-tap-design.md) records the acceptance contract. A source merge is not a live cutover.

Each 8 GiB guest uses a 9 GiB host runner reservation, matching native acceptance. Artifact-copy initialization is
bounded separately at 2 GiB. The 56 GiB namespace memory quota includes six runners, their supervisors, and the
controller and proxy. Repeated unchanged lifecycle failures retain their condition transition time and wait for the
controller's retry interval instead of creating another Kubernetes status event.

Never drain, cordon, reboot, relabel, change scheduling on, or reconfigure shared nodes for this migration. Only the
specifically approved Tengri Pods may be stopped. Leave global Kata RuntimeClasses/extensions and unrelated workloads
alone. No direct worktree deployment, host-device chmod, privileged slot, host PID/network, or host filesystem mount
is part of this lifecycle.

## Source and release contract

- Controller/runner/supervisor and generated CRD live under `services/tengri/`.
- Guest kernel/root and Nanoagent live under `services/nanoagent/`.
- Tengri desired state lives under `argocd/applications/tengri/`.
- Device allocation and its slot admission restriction live under `argocd/applications/tengri-devices/`, enrolled in the
  platform ApplicationSet at wave 1. That Application installs the policy and binding at wave -1 before the device
  plugin at wave 0, independently of held Tengri image delivery.
- SPIRE registers only the host slot supervisor, with the exact Pod UID and container selector.
- Prepared slots use `tengri-slots`, host supervisor SPIRE registration, and a private guest vsock credential.
- Legacy guest identity and network resources are absent from the final source. Their reviewed removal follows the
  last approved old guest's writer fencing; the initial cutover cannot reconcile that removal while an old guest runs.
- `tengri` namespace admission is already `privileged`; slot admission constrains the device/capability profile.

Keep immutable controller and guest digests from the same source revision. CRD and namespace retain their
`Prune=false,Delete=false` protection. Kargo owns eligible images, Freight, and the generated `kargo/tengri` branch.
The paired publisher must withhold discoverable aliases until both builds, component checks, artifact retention,
and KVM acceptance pass. No operator-created image alias or digest promotion PR may bypass those gates.

## Required secrets and configuration

Tengri stores production credentials in three strict-scope SealedSecrets:

- `argocd/applications/tengri/sealed-secret.yaml` creates `tengri/tengri-runtime`.
- `argocd/applications/proompteng/sealed-secret.yaml` creates `proompteng/tengri-bff`.
- `argocd/applications/tengri/spicedb-key-sealedsecret.yaml` creates `tengri/tengri-spicedb-key`, mounted only by the
  controller. It copies the existing Ofz API credential. Regenerate it with
  `nix develop -c python3 scripts/seal-tengri-authz.py --context galactic-tailscale` when that credential rotates.

Workspace access uses the shared Ofz SpiceDB service. The first controller startup installs the Tengri schema into an
empty service and enrolls retained workspaces before accepting traffic. Later startups preserve grants and revocations.
See the [workspace authorization contract](../../services/tengri/README.md#workspace-authorization) for schema,
enrollment, failure behavior, revocation, and rollout verification. The controller requires `TENGRI_AUTHZ_ENDPOINT` and
`TENGRI_AUTHZ_KEY_FILE`; the committed Deployment sets both. SpiceDB failure makes authorization and readiness fail.

The plaintext inputs are these case-sensitive environment variables:

- `BETTER_AUTH_SECRET`: at least 32 random bytes for encrypted, stateless web sessions.
- `GITHUB_CLIENT_ID`: the Tengri GitHub OAuth application client ID.
- `GITHUB_CLIENT_SECRET`: the matching GitHub OAuth application client secret.
- `TENGRI_INTERNAL_HMAC_SECRET`: one 32-byte signing key encoded as exactly 64 lowercase hexadecimal characters
  (`openssl rand -hex 32`). The controller and BFF must receive the same value. Base64url keys and comma-separated
  rotation bundles are rejected.
- `TENGRI_TICKET_SIGNING_SECRET`: at least 32 random bytes for one-use terminal and preview tickets.

The BFF reads the first four values. The controller reads the final two. Both manifests must be generated in one run so
the controller and BFF receive the same HMAC signing key. Rotate that single key as part of the coordinated rollout;
both services must use the replacement before admitting traffic. The sealing script validates every input, keeps plaintext
out of command arguments and files, uses namespace/name-bound strict scope, and writes only encrypted manifests. Before
sealing, it also submits a random invalid authorization code with the production callback URL and requires GitHub to
return `bad_verification_code`. GitHub returns `incorrect_client_credentials` for a wrong client pair and
`redirect_uri_mismatch` for an unregistered callback, so either mistake stops the generator before it replaces a
manifest. See [GitHub's OAuth token request errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors).

Generate or rotate both manifests from the repository root. The local landing environment supplies the first four
values; the ticket key is generated only for this rotation and is never written in plaintext:

```bash
set -euo pipefail
set +x

export TENGRI_TICKET_SIGNING_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
bun --env-file=apps/landing/.env.local scripts/seal-tengri-runtime.ts
unset TENGRI_TICKET_SIGNING_SECRET
```

Validate the ciphertext against the active controller before committing:

```bash
set -euo pipefail

for manifest in \
  argocd/applications/tengri/sealed-secret.yaml \
  argocd/applications/proompteng/sealed-secret.yaml; do
  kubeseal --validate \
    --controller-name sealed-secrets \
    --controller-namespace sealed-secrets \
    < "$manifest"
done
```

After Argo reconciles both applications, require both SealedSecrets, their target Secrets, and both Deployments to be
ready before treating the release as available:

```bash
set -euo pipefail

kubectl --context galactic-lan -n tengri wait \
  --for=condition=Synced sealedsecret/tengri-runtime --timeout=5m
kubectl --context galactic-lan -n proompteng wait \
  --for=condition=Synced sealedsecret/tengri-bff --timeout=5m

test "$(kubectl --context galactic-lan -n tengri get secret tengri-runtime -o json | jq -r '.data | keys | sort | join(",")')" = \
  'TENGRI_INTERNAL_HMAC_SECRET,TENGRI_TICKET_SIGNING_SECRET'
test "$(kubectl --context galactic-lan -n proompteng get secret tengri-bff -o json | jq -r '.data | keys | sort | join(",")')" = \
  'BETTER_AUTH_SECRET,GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET,TENGRI_INTERNAL_HMAC_SECRET'

kubectl --context galactic-lan -n tengri rollout status deployment/tengri --timeout=5m
kubectl --context galactic-lan -n proompteng rollout status deployment/proompteng --timeout=5m
```

Finish the cutover with a real browser session. Open `https://proompteng.ai`, sign out any existing session, select
**Sign in with GitHub**, and require GitHub to return to `https://proompteng.ai/api/auth/callback/github` without an
OAuth error. Confirm that the desktop renders the authenticated GitHub user before treating credential delivery as
working. A successful root probe or Deployment rollout is not an authentication test.

Do not merge ciphertext that fails `kubeseal --validate`. The Deployments intentionally remain unavailable rather than
booting with missing or mismatched credentials.

The controller Deployment also configures the namespace, public gateway URL, preview host template, desktop origin,
controller-owned digest-pinned guest image, and controller limits. The browser never receives these secrets, Kubernetes
credentials, or guest bootstrap tokens.

## Lifecycle behavior

`CreateAgent` derives one deterministic CR name per authenticated GitHub owner and claims a prepared slot. The fixed
profile is 4 vCPU, 8 GiB RAM, and 32 GiB home. A completed create or resume means the resume hook passed filesystem,
PTY, and initialized-Codex checks. Preparing or exhausted capacity returns an explicit error.

Manual sleep and `spec.power.idleTimeoutMinutes` use the same snapshot operation. The default idle timeout is 60
minutes, whole minutes through 1440 are allowed, and zero disables automatic sleep. Sleep closes streams, freezes root
and home, saves a full generation, flushes backing files, reaps Firecracker, and evicts snapshot file pages before
acknowledgement. Root edits, shell processes, Codex state, and home files resume from that snapshot. Scheduler memory
requests stay reserved; resident guest RAM is released.

Power & Sleep settings save immediately when the timeout menu changes. Background Codex reads and event-stream
reconnects, terminal heartbeats, and empty terminal frames do not reset the idle clock. Their control-admission CAS
still excludes an already claimed sleep. User commands, terminal input/output, and active agent work keep the workspace
awake. An accepted durable run remains a sleep inhibitor until it reaches a terminal state. A timeout update
replaces the old deadline atomically. If automatic sleep has already claimed the running workspace, the update fails
rather than reporting a saved timeout while the committed sleep proceeds; resume before retrying.

A temporary authorization veto pauses an active workspace without clearing its running intent. Execution stays
stopped while permission is denied; a fresh Ofz permit is required before the saved snapshot resumes automatically.
Quarantine, explicit sleep and committed idle sleep still clear running intent. The desktop distinguishes the temporary
pause from sleep and refreshes its state without sending a lifecycle command.

The journal consumes a snapshot before vCPUs run. A failed save can recover only its still-live guest. A failed restore,
changed disk/image/kernel/CPU identity, lost active runner, or missing Pod retains the claim and home for fenced recovery.
No Lease expiry or missing Kubernetes object proves that a previous storage writer stopped.

### Growing retained homes to 32 GiB

The only current profile uses a 32 GiB home; the six-home namespace quota is 192 GiB. Existing homes must grow in
place, preserving the PVC UID, filesystem UUID, MicroVM UID, owner grant, and files. The CRD permits increasing the
recorded workspace size and rejects shrinking it. It does not admit new 16 GiB profiles.

Use the reviewed image pair through the normal Kargo delivery path. During the authorized maintenance window,
quiesce lifecycle traffic and controller reconciliation, inventory the original MicroVM/PVC/slot UIDs, and save
filesystem UUIDs and hashes of representative retained files. Stop and fence each former VMM and storage writer
before modifying its disk or enrolling a replacement slot. Follow the retained-home enrollment procedure below;
never delete a retained PVC or initialize it as blank.

After the reviewed quota and CRD have reconciled, increase each original PVC's `spec.resources.requests.storage`
to `32Gi` using UID and resourceVersion preconditions. Wait for its reported capacity and attached raw block device
to reach 34,359,738,368 bytes. Update the existing MicroVM's `spec.resources.workspaceGib` to `32` and enroll the
same PVC with initialization marked `complete` against the reviewed boot image. Cold boot the replacement slot;
ordinary snapshot resume retains the former guest device geometry and does not execute guest initialization.

Guest initialization requires the full 32 GiB raw device, checks the recognized ext4 filesystem with `e2fsck -p -f`,
and runs `resize2fs /dev/vdb` before mounting it and starting Nanoagent. Only clean or corrected filesystem checks
permit growth. A check or resize failure prevents readiness and preserves the home for
recovery. Verify `/dev/vdb` capacity, `df -B1 /home/nanoagent`, unchanged filesystem UUID and retained-file hashes,
a synced write, conversation recovery, terminal use, and browser operation before reopening lifecycle traffic.
Expansion cannot be rolled back by shrinking the PVC. On failure, retain the expanded PVC and fenced claim and
repair or repeat the cold boot; do not restore an older memory snapshot over the changed filesystem.

[Firecracker's block update documentation](https://github.com/firecracker-microvm/firecracker/blob/v1.16.1/docs/api_requests/patch-block.md)
requires an unused, unmounted guest device for its supported `PATCH /drives` procedure. Do not use that API to
change an active home. Kubernetes expands the raw PVC; guest initialization grows its ext4 filesystem.

Deletion first records authenticated VMM stop proof on the MicroVM. Then it deletes the exact Pod incarnation and its
owned disks/token/Lease with UID and resourceVersion preconditions, and removes the finalizer. The durable stop receipt
lets cleanup retry after the Pod has disappeared. A receipt for another Pod UID never authorizes deletion.

Claimed slots keep their image during releases and ordinary sleep. Unused old-image slots are reserved with a Lease
CAS, stopped, and retired with the same proof-before-deletion rule. Fresh replacements never inherit another owner's
memory, home, token, or snapshot. Sleeping homes still occupy one of the six owner slots. No other owner is evicted.

### Replacing a claimed guest while retaining its home

Use this procedure during an authorized maintenance window when a paired release changes the guest API or snapshot
contract. Keep image publication held until enrollment is complete. Preserve the existing MicroVM, home PVC,
filesystem, owner grant, credentials, and native conversations. The replacement cold-boots once; it cannot resume the
old memory snapshot.

1. Qualify the complete Ofz, Tengri, Nanoagent, and Proompteng image cohort from one reviewed source. Record the four
   digests and the original successful publication runs. Freeze that source for the maintenance window and verify
   no other main native workflow occupies its publisher concurrency before taking the workspace offline.
   Finish active work and reconcile uncertain external effects.
   An idle browser, a transcript, or a sleeping snapshot alone does not establish that work completed.
2. Finish authenticated workspace sleep, or verify that normal automatic Sleep has completed. Require desired and
   observed Sleep, the reaped Firecracker process, and no other storage writer. A sleeping journal must name the exact
   runtime claim. A prepared vacant journal must have a positive snapshot generation, no runtime claim, and the same
   MicroVM and Lease allocation, image, Pod and home identities. It does not prove native execution acceptance.
   Accept only an absent activity pin or `idle-sleep/<exact runtime epoch>`; another pin blocks the migration.
   Require all Restate run and control invocations to be terminal. Capture a fresh baseline after work finishes:
   MicroVM, Lease, Pod and PVC UIDs; filesystem UUID; representative file hashes; and native conversation identities.
3. Record the Tengri Application's UID, source, and sync policy. Confirm its owning ApplicationSet preserves
   [`argocd.argoproj.io/skip-reconcile`](https://argo-cd.readthedocs.io/en/release-3.4/user-guide/skip_reconcile/),
   then set that annotation to `true` on only this Application. Preserve its sync
   policy and Kargo metadata. Quiesce the old controller with UID/resourceVersion preconditions and verify its Pods
   have terminated before changing the retained binding.
4. Delete only the fenced slot Pod incarnation with UID/resourceVersion preconditions. Verify termination and safe
   volume detachment. If fencing or storage custody is uncertain, retain the claim and stop. Never delete the home
   PVC, clear a storage lock, or force-detach its volume to proceed.
5. Keep the Lease UID, holder identity, slot epoch, home name and home UID. Set its image annotation and the original
   MicroVM's image to the qualified Nanoagent digest. Verify the home initialization annotation remains `complete`.
   Retain the old Lease Pod UID and MicroVM slot binding for now. These references prevent pool recreation while the
   old controller is absent. Use fresh resourceVersion preconditions for each change.
6. Release the original successful publishers through the existing hold. Rerun only the native publisher and web
   index publisher against their unchanged architecture artifacts. Verify all four index digests remain exact, and
   require successful signing and artifact retention before aliases appear. Retain a queued publisher: cancelling a latest attempt with no jobs can
   prevent rerunning its original job. Do not rebuild or substitute a guest digest after enrollment.
7. Follow the same Freight through Ofz migration and rollout, then the generated `kargo/tengri` commit. Verify that
   commit selects the qualified controller and guest digests before removing the Application's temporary
   `skip-reconcile` annotation. Let Argo restore the reviewed controller replicas from Git.
8. After the new controller revision is present, clear only the old Lease Pod UID annotation, then clear
   `MicroVM.spec.slot`. Keep the home and allocation identity unchanged. The controller prepares a new Pod from the
   enrolled image, records its actual UID, and binds it to the existing MicroVM. Do not invent or copy a successor Pod
   UID, replace the Lease, or assign another prepared home.
9. Verify the new slot and registered Restate worker, then complete the upstream Tengri verification and downstream
   Proompteng promotion. Resume through authenticated Ofz lifecycle control. Read back the unchanged filesystem UUID,
   retained files and conversations. Exercise run recovery, approval, cancellation, worker replacement, and active-run
   sleep exclusion before reopening normal work.

After product acceptance, verify that no competing unqualified native publisher is active, then restore
`TENGRI_PREPARED_SLOT_GUEST_API_VERSION` to the qualified source's guest API protocol for normal delivery. Keep the
Application unpaused and its source, sync policy
and Kargo metadata intact. Set the publication hold again before a future incompatible guest API or snapshot change.

If the replacement fails, keep traffic closed and retain the home and claim for repair. Once the new guest writes,
never restore its older memory snapshot against the advanced disk. Recovery must use a reviewed compatible image
cohort and an explicit retained-home cold boot.

## Permission review and hard cutover

Implementation and read-only validation can proceed before rollout. New device/identity grants and execution of a KVM
fixture require their explicit scoped authorization. Review the exact rendered device plugin, slot admission, SPIRE
registration, container capabilities, namespace, image digests, target, resource limits, and cleanup before applying them.
Production cutover requires separate authorization. An isolated Docker fixture grant does not authorize a cluster rollout.

Image delivery is held independently of source merge. The image workflow still requires component and strict KVM
acceptance and can publish verified immutable `sha-<source>` images and their retained indexes. It withholds both
discoverable `kargo-sha-<source>` aliases unless the repository variable `TENGRI_PREPARED_SLOT_GUEST_API_VERSION` matches
`GUEST_API_PROTOCOL_VERSION` in the qualified source. An unset, malformed or different protocol keeps the current
automatic Kargo policy from selecting this migration. Leave it held
until the approved old writers are fenced and every retained home is enrolled with the exact staged guest digest.
The Proompteng image workflow uses the same hold for its Kargo alias because conversation recovery now requires the
streaming Tengri RPC. Stage its immutable image too, then release both applications from the same reviewed source
within the approved maintenance window. Open the desktop only after the existing conversation loads through the new
stream. A rollback across this RPC change must move both applications together within a maintenance window.
The desktop image workflow and Warehouse include the complete Tengri controller source, so a runtime repair also
builds the desktop and makes that same source revision eligible for its automatic promotion.

The device plugin supplies only KVM/TUN, using existing ready-node labels. The TAP init container gets NET_ADMIN only in
the Pod network namespace. The runner starts with MKNOD/SETUID/SETGID only to create its private block-device inode and
drop UID/GID. Runtime and Firecracker capability sets must all be empty. The supervisor alone receives SPIFFE CSI access.
The Async block engine requires the generated, runner-only seccomp profile. Omni's native Talos
`machine.seccompProfiles` manages it at `/var/lib/kubelet/seccomp/profiles/tengri-runner.json`; only the runner selects
`profiles/tengri-runner.json`. Other containers retain RuntimeDefault. Validate the complete current machine
configuration and require a no-reboot server dry run on each target before syncing the approved profile change.
The existing Alloy collector also needs the scoped NetworkPolicy ingress to slot health port 8080 for responsiveness
metrics. Host device inode permissions, namespace labels and scheduling do not change.

Before merging a change that would automatically reconcile new SPIRE permissions or expose a new Kargo image pair,
require authorization for that effect or keep delivery held at the PR boundary. Do not treat a manual sync omission as
a release hold when the configured Application or Stage is automatic.

A reviewed cutover follows this order:

1. Complete native builds, component checks, isolated KVM acceptance, and permission review. Record exact source,
   paired artifacts, kernel/Firecracker pins, measurement boundary, p50/p95/max, RAM release, failures, and exclusions.
2. Through reviewed GitOps and the [Omni procedure](../../devices/galactic/omni/README.md), reconcile only approved
   device, host-SPIRE and native seccomp prerequisites. Read back the profile resource and file on each target;
   verify actual allocations and supervisor identity. Confirm the slot admission policy and its Deny binding are installed
   before KVM/TUN allocations are advertised. Before the initial device Application enrollment, record zero advertised
   `runtime.proompteng.ai/kvm-tun` capacity across all nodes and zero existing Pod requests or limits for that resource
   across all namespaces, including pending Pods. A new admission policy does not fence earlier allocations. If either
   inventory is nonempty, stop enrollment and obtain scoped authority to fence those allocations or withdraw the
   plugin; prove the inventories are empty before proceeding. Do not remove registrations used by running old guests yet.
3. Stop only the approved old Tengri guests at the owner/maintenance boundary. Prove the old VMM/process and its
   storage writer are fenced. Retain every original MicroVM UID, home PVC UID, filesystem, ownership, and contents.
   Keep the old controller quiesced throughout fencing and enrollment so it cannot restart old writers or recreate bootstrap Secrets.
   After each old Pod is gone, remove only its `<MicroVM name>-bootstrap` Secret with matching MicroVM owner UID
   and Secret UID/resourceVersion preconditions. Preserve the two controller credential Secrets. At six agents,
   this frees the six legacy bootstrap allocations before creating six new slot tokens under the unchanged eight-Secret quota.
4. Enroll each retained home before starting the new controller. A reserved slot Lease uses the existing selector,
   `holderIdentity` JSON `{microvmId, microvmUid, epoch}`, and annotations `runtime.proompteng.ai/home-name`,
   `runtime.proompteng.ai/home-uid`, and `runtime.proompteng.ai/image` for the approved immutable boot image. Set the home initialization annotation to `complete`.
   Update that MicroVM's image to the same boot digest and retain its owner/finalizer. Do not set a new Pod UID yet.
   An operator enrollment must contain external proof of old-writer fencing; Lease creation itself supplies none.
5. After the approved fencing, Secret cleanup and enrollment are complete, set `TENGRI_PREPARED_SLOT_GUEST_API_VERSION`
   to the qualified source's guest API protocol and rerun the image workflow for the same approved `main` commit and staged image pair. Require all
   validation/signing gates again; the workflow then exposes both aliases through the normal publication path.
   Kargo's existing automatic policy promotes that pair and Argo reconciles its generated branch. The pool prepares the
   reserved retained home, records the new Pod UID, and binds/adopts it. Open lifecycle traffic only after those slots
   are prepared. The old Kata path has no transferable snapshot, so existing processes restart once at cutover.
6. Remove the old `nanoagent` ServiceAccount, its token-issuance Role rule, `tengri-guest-identities` ClusterRole/Binding
   and admission policy/binding, guest PSAT/token-renewal resources, `tengri-microvm-guests`, and its controller egress rule only after
   their last approved old guest is stopped. Reconcile the reviewed SPIRE configuration while preserving its host
   attestor, host bundle publisher, datastore, signing-key volumes, and host workload registrations. Verify host canary
   identity rotation. The old `spire-guest-bundle` ConfigMap and `tengri-microvm-guests` policy have pruning protection;
   source omission does not delete them. Retire those exact resources with UID/resourceVersion preconditions only after
   their publisher/consumers are gone, then verify all retired resources are absent. Verify authenticated
   create/resume through files, a real terminal, initialized Codex, previews, and editor content. Confirm unchanged
   retained PVC UIDs and unchanged shared-node scheduling. Accept no health-only substitute.

Normal delivery follows main publication, eligible Warehouse/Freight, exact automatic Stage promotion, generated
`kargo/tengri`, Argo reconciliation, workload rollout, and product proof. Read promotion and application evidence with
explicit namespaces:

```bash
kubectl --context galactic-lan -n lab-delivery get warehouse,freight,stage
kubectl --context galactic-lan -n lab-delivery get stage/tengri -o yaml
kubectl --context galactic-lan -n argocd get application/tengri application/proompteng -o yaml
kubectl --context galactic-lan -n tengri get microvm,lease,pod,pvc
```

A hard migration does not provide runtime downgrade compatibility. Recovery preserves the original home; use a
snapshot-compatible image set or an explicitly fenced retained-home cold boot. Never send new snapshots to an older
controller or replace/reformat a home to make readiness pass.

### Proompteng desktop image promotions

The Kargo `proompteng` Stage copies the source commit and full image/build metadata to `kargo/proompteng` and pushes it
without a pull request. The Argo Application tracks that branch. The repository Kustomization on `main` remains the
reviewed configuration baseline. The production Deployment has one replica with `maxSurge: 1` and `maxUnavailable: 0`.
Kubernetes keeps the existing ready Pod until its replacement passes readiness. If capacity prevents the surge Pod
from scheduling, the rollout waits with the existing Pod serving traffic. Existing streams reconnect when their web
Pod terminates. The Firecracker guest Pod and its PVC continue running during this web-only rollout.

After Kargo promotes a Freight, require all of the following before calling the rollout complete:

```bash
set -euo pipefail

kubectl --context galactic-lan -n lab-delivery get freight,stage
kubectl --context galactic-lan -n lab-delivery get stage/proompteng -o yaml
kubectl --context galactic-lan -n argocd get application/proompteng \
  -o jsonpath='{.status.sync.status}{"\n"}{.status.health.status}{"\n"}'
kubectl --context galactic-lan -n argocd get application/proompteng \
  -o jsonpath='{.spec.source.targetRevision}{"\n"}{.status.sync.revision}{"\n"}'
kubectl --context galactic-lan -n proompteng rollout status deployment/proompteng --timeout=5m
kubectl --context galactic-lan -n proompteng get deployment/proompteng \
  -o jsonpath='{.status.readyReplicas}/{.status.replicas}{"\n"}'

proompteng_image_id=$(kubectl --context galactic-lan -n proompteng get pod -l app=proompteng -o json | jq -er '
  [.items[] | select(.status.containerStatuses[0].ready == true) | .status.containerStatuses[0].imageID]
  | if length == 1 then .[0] else error("expected exactly one ready proompteng Pod") end')
test -n "$proompteng_image_id"
curl --fail --silent --show-error --output /dev/null https://proompteng.ai/
```

The kubelet can report the promoted multi-platform index digest or the selected platform child-manifest digest; compare
the running image ID with the Freight digest and its published child manifest. The Deployment must return to `1/1`,
and the Argo application must be `Synced` and `Healthy`. Finish with the built-in browser: reload
`https://proompteng.ai`, require the authenticated desktop to return to `Connected`, and exercise the capability changed
by the promoted source. Deployment health and an HTTP 200 alone are not sufficient product acceptance.

If the replacement Pod does not become ready or the browser acceptance fails, fix the source-owned failure and
re-promote the previously proven Proompteng Freight through Kargo. Kargo rewrites `kargo/proompteng` and Argo
reconciles it. Do not create a digest PR, patch the live Deployment, delete the SealedSecrets, or change the running
microVM while rolling the web image back.

## Observability

The cluster does not install the Prometheus Operator monitoring CRDs. The shared observability Alloy collector is the
authoritative equivalent of a ServiceMonitor: it scrapes only `up` and bounded `tengri_*` metrics from
`tengri-gateway.tengri.svc.cluster.local:8080`, then remote-writes them to Mimir. The Tengri NetworkPolicy permits this
single observability-namespace path and does not expose the preview listener to the collector.

Mimir alerts cover a missing control-plane scrape, missing slot Pods, an unavailable slot pool, failed microVM agents,
repeated guest failures, high boot and resume latency, and global quota rejection. `TengriSlotPodsMissing` fires when
fewer than the six required slot Pods exist for five minutes. `TengriSlotPoolUnavailable` fires when no slot Pod is Ready
for five minutes. Both use kube-state-metrics, so a healthy controller scrape or Argo application cannot hide a lost pool.
An occupied, healthy pool does not fire either alert. The existing quota rejection alert covers exhausted capacity.
All Tengri alerts link back to this runbook and use bounded labels; owner hashes,
agent IDs, terminal IDs, prompts, file contents, and ticket material must never appear in metrics.

Fixed-bucket histograms distinguish guest connection setup and identity verification
(`tengri_guest_connect_seconds`), guest terminal attachment (`tengri_terminal_attach_seconds`),
first nonempty PTY output (`tengri_terminal_first_output_seconds`), and control-plane-to-guest terminal ping
round trips (`tengri_terminal_heartbeat_seconds`). Terminal timings start after the WebSocket upgrade;
they exclude frontend API requests, browser transport, and rendering. A reattached terminal with no new output
does not produce a first-output observation until bytes arrive, so that series is diagnostic, not a startup alert.
The heartbeat alert requires at least ten observations in five minutes and p95 above 100 ms for five minutes.
Guest connection p95 above 300 ms requires at least five observations in fifteen minutes and five minutes of delay.
An idle histogram does not establish responsiveness. Correlate these timings with the Ceph read/queue alerts
and browser measurements before attributing a stall to a specific layer.

For a missing slot Pod, inspect its Lease, MicroVM, and original home PVC. Follow the fenced recovery procedure above
before resetting a binding. Pod absence alone does not prove that its former storage writer stopped. Preserve the
original MicroVM and PVC UIDs, owner grants, and files. Critical Tengri alerts use the existing `notify: email` route.

After the observability application reconciles, verify collection and rule loading without exposing user data:

```bash
set -euo pipefail

kubectl --context galactic-lan -n observability port-forward \
  service/observability-mimir-gateway 19090:80 &
tengri_mimir_port_forward_pid=$!
trap 'kill "$tengri_mimir_port_forward_pid" 2>/dev/null || true' EXIT INT TERM

curl --fail --silent --show-error --get \
  --header 'X-Scope-OrgID: anonymous' \
  --data-urlencode 'query=up{job="tengri",namespace="tengri"}' \
  http://127.0.0.1:19090/prometheus/api/v1/query
curl --fail --silent --show-error --get \
  --header 'X-Scope-OrgID: anonymous' \
  --data-urlencode 'query=tengri_agents{job="tengri",namespace="tengri"}' \
  http://127.0.0.1:19090/prometheus/api/v1/query
curl --fail --silent --show-error \
  --header 'X-Scope-OrgID: anonymous' \
  http://127.0.0.1:19090/prometheus/config/v1/rules/lab/tengri-production.rules
```

## Validation and acceptance

```bash
cargo fmt --manifest-path services/tengri/Cargo.toml --check
cargo clippy --manifest-path services/tengri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/tengri/Cargo.toml --locked --all-targets
bash services/tengri/test-rpc-interop.sh
kustomize build argocd/applications/tengri > /tmp/tengri-rendered.yaml
kustomize build argocd/applications/tengri-devices > /tmp/tengri-devices-rendered.yaml
shellcheck services/tengri/network.sh services/tengri/test-kvm*.sh
bun run lint:argocd
```

The isolated KVM runner preserves JSON timing results, host test logs, and Firecracker logs before removing its own
private container and volumes. Its real-guest test checks same-shell/file continuity, current owner/epoch, host SVID
rotation, and snapshot page eviction. Routine image publication gates on three real sleep/resume cycles per
architecture, with every resume below one second. A three-minute first sleep exercises renewal beyond the previous
host certificate lifetime. The manual `Tengri images` workflow input `kvm_samples=50` runs the longer performance
qualification. Smoke receipts have `validationMode: smoke` and a null p95; they do not establish a latency
distribution. This boundary excludes BFF authentication, real Kubernetes latency, raw PVC
allocation, fresh-creation distribution, and six concurrent guests. Those exclusions remain acceptance requirements,
not inferred successes. Measure at least 50 fresh prepared creations and 50 cold-cache resumes through the authenticated
product path before claiming p95 below one second. Report sleep duration separately.

Use [the chat acceptance contract](agent-chat.md) for authenticated account, turn/event, approval, editor, and preview
proof. Infrastructure health, unit tests, or a fast Firecracker API call do not establish usable end-to-end latency.

## Recovery

A controller restart leaves existing slot Pods and owned homes intact. A sleeping runner can reopen its committed
journal only with matching pins and identity. An active runner restart, missing Pod, partition, or incompatible snapshot
fails closed and retains the claim/home. Fence only that affected old VMM and establish exclusive storage access before
an explicitly authorized cold replacement. No node drain/reboot or age-based Lease stealing is allowed.

For stuck deletion, inspect the current slot binding, stop receipt, exact Pod UID, home UID, and remaining assets.
Do not remove the finalizer or claim while VMM termination or writer exclusivity is unproven. Repair the owning source
and repeat the same operation rather than hiding failure or substituting a new disk.
