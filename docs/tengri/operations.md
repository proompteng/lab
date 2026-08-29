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

Before enabling or promoting Tengri, create exactly one item named `tengri-runtime` in the 1Password `infra` vault.
Both production ExternalSecrets read that same item:

- `tengri/tengri-runtime` creates the controller Secret `tengri-runtime`.
- `proompteng/tengri-bff` creates the web BFF Secret `tengri-bff`.

The item must contain these case-sensitive fields:

- `BETTER_AUTH_SECRET`: at least 32 random bytes for encrypted, stateless web sessions.
- `GITHUB_CLIENT_ID`: the Tengri GitHub OAuth application client ID.
- `GITHUB_CLIENT_SECRET`: the matching GitHub OAuth application client secret.
- `TENGRI_INTERNAL_HMAC_SECRET`: one base64url signing key of at least 32 bytes, or `new,current` during rotation. The
  controller and BFF must receive the same value.
- `TENGRI_TICKET_SIGNING_SECRET`: at least 32 random bytes for one-use terminal and preview tickets.

The BFF reads the first four fields. The controller reads the final two. Never duplicate the HMAC value into separate
1Password items because the independently refreshed workloads must retain the same signing bundle.

Verify the item and all required fields without printing their values before merging the first promotion:

```bash
(
  set -euo pipefail
  set +x

  test "$(op item list --vault infra --format json | jq '[.[] | select(.title == "tengri-runtime")] | length')" -eq 1

  for field in \
    BETTER_AUTH_SECRET \
    GITHUB_CLIENT_ID \
    GITHUB_CLIENT_SECRET \
    TENGRI_INTERNAL_HMAC_SECRET \
    TENGRI_TICKET_SIGNING_SECRET; do
    value="$(op item get tengri-runtime --vault infra --fields "label=$field" --reveal)"
    test -n "$value"
    case "$field" in
      BETTER_AUTH_SECRET | TENGRI_TICKET_SIGNING_SECRET)
        test "${#value}" -ge 32
        ;;
      TENGRI_INTERNAL_HMAC_SECRET)
        IFS=',' read -r -a hmac_keys <<<"$value"
        test "${#hmac_keys[@]}" -ge 1
        test "${#hmac_keys[@]}" -le 2
        for key in "${hmac_keys[@]}"; do
          [[ "$key" =~ ^[A-Za-z0-9_-]{32,}$ ]]
        done
        unset hmac_keys key
        ;;
    esac
  done
  unset value field
)
```

After Argo creates both ExternalSecrets, require both provider reads and both target Secrets to succeed before treating
the release as available:

```bash
set -euo pipefail

kubectl --context galactic-lan -n tengri wait \
  --for=condition=Ready externalsecret/tengri-runtime --timeout=5m
kubectl --context galactic-lan -n proompteng wait \
  --for=condition=Ready externalsecret/tengri-bff --timeout=5m
kubectl --context galactic-lan -n tengri get secret tengri-runtime
kubectl --context galactic-lan -n proompteng get secret tengri-bff
```

Do not merge or retry a rollout while either ExternalSecret reports `SecretSyncedError`; fix the 1Password item first.
The Deployments intentionally remain unavailable rather than booting with missing or mismatched credentials.

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
