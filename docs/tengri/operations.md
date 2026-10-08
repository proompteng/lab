# Tengri operations

Tengri uses six prepared Firecracker slots under the normal OCI runtime. Each has a host supervisor, unprivileged VMM
runner, Pod-local TAP, private snapshot/root disks, and a retained 16 GiB Ceph raw-block home. Source behavior is defined
by [the service README](../../services/tengri/README.md) and [slot code](../../services/tengri/src/slot/).
The [KVM/TAP design](kvm-tap-design.md) records the acceptance contract. A source merge is not a live cutover.

Never drain, cordon, reboot, relabel, change scheduling on, or reconfigure shared nodes for this migration. Only the
specifically approved Tengri Pods may be stopped. Leave global Kata RuntimeClasses/extensions and unrelated workloads
alone. No direct worktree deployment, host-device chmod, privileged slot, host PID/network, or host filesystem mount
is part of this lifecycle.

## Source and release contract

- Controller/runner/supervisor and generated CRD live under `services/tengri/`.
- Guest kernel/root and Nanoagent live under `services/nanoagent/`.
- Tengri desired state lives under `argocd/applications/tengri/`.
- Device allocation lives under `argocd/applications/tengri-devices/`, enrolled in the platform ApplicationSet at wave 1.
- SPIRE registers only the host slot supervisor, with the exact Pod UID and container selector.
- Existing guest `nanoagent` ServiceAccount, token and registration RBAC, admission restrictions, attestation and bundle publication remain configured until the last old guest is stopped at cutover.
- The existing guest NetworkPolicy and controller egress remain through cutover; prepared slots use `tengri-slots`.
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
- `TENGRI_INTERNAL_HMAC_SECRET`: one base64url signing key of at least 32 bytes, or `new,current` during rotation. The
  controller and BFF must receive the same value.
- `TENGRI_TICKET_SIGNING_SECRET`: at least 32 random bytes for one-use terminal and preview tickets.

The BFF reads the first four values. The controller reads the final two. Both manifests must be generated in one run so
the controller and BFF receive the same HMAC signing bundle. The sealing script validates every input, keeps plaintext
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
profile is 4 vCPU, 8 GiB RAM, and 16 GiB home. A completed create or resume means the resume hook passed filesystem,
PTY, and initialized-Codex checks. Preparing or exhausted capacity returns an explicit error.

Manual sleep and `spec.power.idleTimeoutMinutes` use the same snapshot operation. The default idle timeout is 60
minutes, whole minutes through 1440 are allowed, and zero disables automatic sleep. Sleep closes streams, freezes root
and home, saves a full generation, flushes backing files, reaps Firecracker, and evicts snapshot file pages before
acknowledgement. Root edits, shell processes, Codex state, and home files resume from that snapshot. Scheduler memory
requests stay reserved; resident guest RAM is released.

The journal consumes a snapshot before vCPUs run. A failed save can recover only its still-live guest. A failed restore,
changed disk/image/kernel/CPU identity, lost active runner, or missing Pod retains the claim and home for fenced recovery.
No Lease expiry or missing Kubernetes object proves that a previous storage writer stopped.

Deletion first records authenticated VMM stop proof on the MicroVM. Then it deletes the exact Pod incarnation and its
owned disks/token/Lease with UID and resourceVersion preconditions, and removes the finalizer. The durable stop receipt
lets cleanup retry after the Pod has disappeared. A receipt for another Pod UID never authorizes deletion.

Claimed slots keep their image during releases and ordinary sleep. Unused old-image slots are reserved with a Lease
CAS, stopped, and retired with the same proof-before-deletion rule. Fresh replacements never inherit another owner's
memory, home, token, or snapshot. Sleeping homes still occupy one of the six owner slots. No other owner is evicted.

## Permission review and hard cutover

Implementation and read-only validation can proceed before rollout. New device/identity grants and execution of a KVM
fixture require their explicit scoped authorization. Review the exact rendered device plugin, slot admission, SPIRE
registration, container capabilities, namespace, image digests, target, resource limits, and cleanup before applying them.
Production cutover requires separate authorization. An isolated Docker fixture grant does not authorize a cluster rollout.

Image delivery is held independently of source merge. The image workflow still requires component and strict KVM
acceptance and can publish verified immutable `sha-<source>` images and their retained indexes. It withholds both
discoverable `kargo-sha-<source>` aliases unless the repository variable `TENGRI_PREPARED_SLOT_CUTOVER_READY` is exactly
`true`; an unset or false value keeps the current automatic Kargo policy from selecting this migration. Leave it held
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
No permission change to host device inodes, node configuration, namespace labels, or scheduling is needed.

Before merging a change that would automatically reconcile new SPIRE permissions or expose a new Kargo image pair,
require authorization for that effect or keep delivery held at the PR boundary. Do not treat a manual sync omission as
a release hold when the configured Application or Stage is automatic.

A reviewed cutover follows this order:

1. Complete native builds, component checks, isolated KVM acceptance, and permission review. Record exact source,
   paired artifacts, kernel/Firecracker pins, measurement boundary, p50/p95/max, RAM release, failures, and exclusions.
2. Through reviewed GitOps, reconcile only approved device/host-SPIRE prerequisites. Verify actual allocations and
   supervisor identity without modifying nodes. Do not remove registrations used by running old guests yet.
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
5. After the approved fencing, Secret cleanup and enrollment are complete, set `TENGRI_PREPARED_SLOT_CUTOVER_READY`
   to `true` and rerun the image workflow for the same approved `main` commit and staged image pair. Require all
   validation/signing gates again; the workflow then exposes both aliases through the normal publication path.
   Kargo's existing automatic policy promotes that pair and Argo reconciles its generated branch. The pool prepares the
   reserved retained home, records the new Pod UID, and binds/adopts it. Open lifecycle traffic only after those slots
   are prepared. The old Kata path has no transferable snapshot, so existing processes restart once at cutover.
6. Remove the old `nanoagent` ServiceAccount, its token-issuance Role rule, `tengri-guest-identities` ClusterRole/Binding
   and admission policy/binding, guest PSAT/token-renewal resources, `tengri-microvm-guests`, and its controller egress rule only after
   their last approved old guest is stopped. Verify authenticated
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

Mimir alerts cover a missing control-plane scrape, failed microVM agents, repeated guest failures, high boot and resume
latency, and global quota rejection. All Tengri alerts link back to this runbook and use bounded labels; owner hashes,
agent IDs, terminal IDs, prompts, file contents, and ticket material must never appear in metrics.

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
rotation, and snapshot page eviction. This boundary excludes BFF authentication, real Kubernetes latency, raw PVC
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
