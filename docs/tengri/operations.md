# Tengri operations

Tengri is delivered only through CI and the `tengri` Argo CD application. It owns namespaced `MicroVM` resources,
their bootstrap Secrets, 16 GiB `rook-ceph-block` PVCs, and unprivileged `kata-fc` Pods. It does not mutate Talos,
Kata RuntimeClasses, node scheduling, or cluster nodes.

## Source and release contract

- Controller source and generated CRD: `services/tengri/`
- GitOps application: `argocd/applications/tengri/`
- API: `services/tengri/proto/proompteng/runtime/v1/microvm.proto`
- Controller image: `registry.ide-newton.ts.net/lab/tengri@sha256:<digest>`
- Guest image: `registry.ide-newton.ts.net/lab/nanoagent@sha256:<digest>`
- RuntimeClass: `kata-fc`
- Namespace: `tengri`, created and labeled by the platform ApplicationSet

Both image references must be immutable digests before the application is enabled. The zero digests in the disabled
scaffold intentionally prevent an accidental rollout. CI regenerates the CRD and compares it with both committed CRD
copies. `Prune=false,Delete=false` protects both the CRD and the ApplicationSet-managed `tengri` namespace when the
application is disabled or removed, preserving existing `MicroVM` resources and their PVC-owned state.

The Kata application contains RuntimeClasses only. It must not contain permanent canary DaemonSets. Runtime proof is a
bounded acceptance operation, not a continuously scheduled workload.

## Required secrets and configuration

Tengri stores production credentials in two strict-scope SealedSecrets:

- `argocd/applications/tengri/sealed-secret.yaml` creates `tengri/tengri-runtime`.
- `argocd/applications/proompteng/sealed-secret.yaml` creates `proompteng/tengri-bff`.

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
fixed guest image, and controller limits. The browser never receives these secrets, Kubernetes credentials, or guest
bootstrap tokens.

## Lifecycle behavior

`CreateAgent` derives a deterministic CR name from the authenticated GitHub subject, so one identity cannot race two
active agents into existence. The server selects the architecture, 2 CPU, 4 GiB memory, 16 GiB workspace, and immutable
guest image.

- `Running`: the controller creates or retains the PVC, bootstrap Secret, and `kata-fc` Pod.
- `Sleeping`: after 60 idle minutes the controller deletes only the Pod; the CR and PVC remain.
- Resume: any authenticated file, terminal, preview, lifecycle, or Codex action sets the desired state to `Running` and
  waits for observed guest readiness before continuing.
- Delete: the finalizer removes the Pod, bootstrap Secret, terminal capabilities, and PVC before removing the CR.
- Expiry: four hours after original creation, the controller performs the same finalizer-backed deletion regardless of
  activity.

Exact failure reasons are published in CR status. Do not infer success from a created Pod alone.

## Rollout

1. Run the controller and Nanoagent tests and verify both generated CRD copies.
2. Merge controller, guest, CRD, or release-tool changes to `main`. `Tengri images` validates both services and CRDs,
   builds native `linux/amd64` and `linux/arm64` images, publishes and signs both multi-architecture indexes, and emits
   one immutable `tengri-release-contract` for that source revision.
3. `Tengri release` verifies the contract, indexes, signatures, and current `main`, then opens one generated promotion
   PR that pins both digests and enables the Tengri ApplicationSet entry and BFF endpoint atomically. A newer relevant
   build immediately invalidates an older open promotion.
4. Review and merge the generated promotion PR; never hand-edit image digests or use the retired manual mirror path.
5. Let Argo reconcile from `main`, then verify the controller Deployment, Service endpoints, `/livez`, `/readyz`, and
   unchanged node scheduling.
6. Run the bounded Firecracker acceptance path: create one authenticated agent, prove `runtimeClassName: kata-fc`,
   guest kernel isolation, fresh-image pull, interactive PTY, persistent file round trip, Codex event, and localhost
   preview WebSocket/HMR.

### Storage layout

Tengri supports only `runtime.proompteng.ai/storage-layout=home-workspace-v2`:

1. Every new CR is marked with that layout directly; there is no activation flag.
2. The Pod mounts its PVC exactly once at `/home/nanoagent`. The Nanoagent image exposes
   `/home/nanoagent/workspace` through `/workspace`; there is no init container or synthetic identity volume.
3. Any CR with a missing or different layout is rejected and must be deleted and recreated. The failed
   `home-workspace-v1` experiment never produced a working guest, so there is no migration or fallback path.

Promote or roll back the controller and Nanoagent digests together through GitOps. Do not mix a controller and guest
image from different releases.

### Proompteng desktop image promotions

The generated product-image promotion updates the immutable `proompteng` digest in
`argocd/applications/proompteng/kustomization.yaml`. The production Deployment has one replica with `maxSurge: 0` and
`maxUnavailable: 1`, so Argo replaces the existing Pod without a surge Pod. A short interval with no ready web Pod is
expected; an open desktop can show a reconnecting or degraded state until the replacement Pod passes its startup and
readiness probes. The Firecracker guest Pod and its PVC continue running during this web-only rollout.

After merging a promotion, require all of the following before calling the rollout complete:

```bash
set -euo pipefail

argocd app get proompteng --hard-refresh
argocd app wait proompteng --sync --health --timeout 300
kubectl --context galactic-lan -n proompteng rollout status deployment/proompteng --timeout=5m
kubectl --context galactic-lan -n proompteng get deployment/proompteng \
  -o jsonpath='{.status.readyReplicas}/{.status.replicas}{"\n"}'

proompteng_image=registry.ide-newton.ts.net/lab/proompteng
proompteng_index_digest=$(yq -er \
  '.images[] | select(.name == "registry.ide-newton.ts.net/lab/proompteng") | .digest' \
  argocd/applications/proompteng/kustomization.yaml)
proompteng_arm64_digest=$(bun run packages/scripts/src/shared/oci.ts inspect \
  "$proompteng_image@$proompteng_index_digest" | awk '$1 == "linux/arm64" { print $2 }')
test -n "$proompteng_arm64_digest"

proompteng_image_id=$(kubectl --context galactic-lan -n proompteng get pod -l app=proompteng -o json | jq -er '
  [.items[] | select(.status.containerStatuses[0].ready == true) | .status.containerStatuses[0].imageID]
  | if length == 1 then .[0] else error("expected exactly one ready proompteng Pod") end')
case "$proompteng_image_id" in
  *"$proompteng_index_digest"|*"$proompteng_arm64_digest") ;;
  *)
    echo "unexpected proompteng imageID: $proompteng_image_id" >&2
    exit 1
    ;;
esac
curl --fail --silent --show-error --output /dev/null https://proompteng.ai/
```

The kubelet can report either the promoted multi-platform index digest or the selected `linux/arm64` child-manifest
digest, so the check accepts exactly those two values from the published index. The Deployment must return to `1/1`,
and the Argo application must be `Synced` and `Healthy`. Finish with the built-in browser: reload
`https://proompteng.ai`, require the authenticated desktop to return to `Connected`, and exercise the capability changed
by the promoted source. Deployment health and an HTTP 200 alone are not sufficient product acceptance.

If the replacement Pod does not become ready or the browser acceptance fails, open a normal follow-up PR that reverts
the promotion commit or restores the previously proven digest in the same Kustomization. Let CI and Argo perform the
rollback. Do not patch the live Deployment, delete the SealedSecrets, or change the running microVM while rolling the
web image back.

Do not deploy from a worktree, directly apply rendered manifests, cordon or drain a node, reboot a node, or create a
permanent canary DaemonSet.

The `kata` Application is intentionally manual. After this canary-removal change reaches `main`, reconcile that
Application once with pruning and verify that only the RuntimeClasses remain:

```bash
set -euo pipefail

argocd app sync kata --prune
argocd app wait kata --sync --health --timeout 300
test -z "$(kubectl --context galactic-lan -n kata get daemonset -o name)"
kubectl --context galactic-lan get runtimeclass kata-fc kata-clh kata-dragonball kata-qemu

PROOF_DIR="/tmp/galactic-kata-proof-$(date -u +%Y%m%dT%H%M%SZ)"
devices/galactic/extensions/kata/verify-runtimes.sh "$PROOF_DIR" talos-192-168-1-194 fc
test -z "$(kubectl --context galactic-lan -n kata get pod,secret \
  -l app.kubernetes.io/component=runtime-acceptance -o name)"
```

The verifier creates one unprivileged, digest-pinned Nanoagent Pod at a time, captures guest and host evidence, and
deletes the Pod plus its unique bootstrap Secret through an exit trap. It never changes node scheduling or Talos.

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

## Validation

```bash
set -euo pipefail

cargo fmt --manifest-path services/tengri/Cargo.toml --check
cargo clippy --manifest-path services/tengri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/tengri/Cargo.toml --locked --all-targets
cargo run --manifest-path services/tengri/Cargo.toml --locked --quiet --bin crdgen > /tmp/tengri-crd.yaml
diff -u /tmp/tengri-crd.yaml services/tengri/crd.yaml
diff -u /tmp/tengri-crd.yaml argocd/applications/tengri/crd.yaml
kustomize build argocd/applications/tengri > /tmp/tengri-rendered.yaml
! yq e 'select(.kind == "Namespace") | .metadata.name' /tmp/tengri-rendered.yaml | grep -q .
bun run lint:argocd
```

The exact live readback commands and rollback procedure are in
[`services/tengri/README.md`](../../services/tengri/README.md).

The authenticated Codex account, thread, event-replay, approval, and end-to-end chat acceptance contract is in
[`agent-chat.md`](./agent-chat.md).

## Recovery

- Controller unavailable: existing guest Pods and PVCs continue running. Revert the image or manifest commit through a
  follow-up PR and allow the singleton `Recreate` Deployment to reconcile.
- Guest `Failed`: inspect the CR status condition, Pod events, image-pull status, and Nanoagent readiness. Fix the
  source-owned cause; do not fabricate progress or bypass `kata-fc`.
- Sleeping guest: call resume or perform an authenticated operation. Do not recreate the PVC.
- Stuck deletion: inspect finalizer status and owned Pod, Secret, and PVC individually. Never remove the finalizer until
  owned resources are confirmed absent or deliberately preserved through an incident procedure.
