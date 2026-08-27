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

The `tengri-runtime` ExternalSecret reads these fields through the existing 1Password ClusterSecretStore:

- `TENGRI_INTERNAL_HMAC_SECRET`: one base64url signing key of at least 32 bytes, or `new,current` during rotation.
- `TENGRI_TICKET_SIGNING_SECRET`: at least 32 bytes for one-use terminal and preview tickets.

The Deployment also configures the namespace, public gateway URL, preview host template, desktop origin, fixed guest
image, and controller limits. The browser never receives either secret, Kubernetes credentials, or guest bootstrap
tokens.

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

1. Run the controller tests and generate the CRD.
2. Merge controller source to `main`. The `Tengri controller` workflow builds natively on `arc-amd64` and `arc-arm64`,
   publishes and signs `registry.ide-newton.ts.net/lab/tengri:sha-<commit>`, verifies both platforms, and records its
   immutable digest in the workflow summary.
3. Build Nanoagent through `.github/workflows/nanoagent.yaml`, then run the `Manual OCI Mirror` workflow with its signed
   GHCR digest, `target_repository=nanoagent`, and an immutable source-derived tag. The mirror verifies both platforms
   and preserves the source digest at `registry.ide-newton.ts.net/lab/nanoagent`.
4. Update the two digest references in `argocd/applications/tengri/kustomization.yaml` and confirm the required 1Password
   fields exist.
5. For the initial rollout, set the `tengri` entry in `argocd/applicationsets/platform.yaml` to `enabled: "true"` in
   the same reviewed rollout PR or a reviewed follow-up. Until that enablement is merged, no Tengri Application,
   Deployment, or endpoint is expected to exist and the remaining live verification steps must not run.
6. Merge the reviewed rollout PR and let the auto-reconciled Tengri Application deploy from `main`.
7. Verify the controller Deployment, Service endpoints, `/livez`, `/readyz`, and unchanged node scheduling.
8. Run the bounded Firecracker acceptance path: create one authenticated agent, prove `runtimeClassName: kata-fc`,
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

## Recovery

- Controller unavailable: existing guest Pods and PVCs continue running. Revert the image or manifest commit through a
  follow-up PR and allow the singleton `Recreate` Deployment to reconcile.
- Guest `Failed`: inspect the CR status condition, Pod events, image-pull status, and Nanoagent readiness. Fix the
  source-owned cause; do not fabricate progress or bypass `kata-fc`.
- Sleeping guest: call resume or perform an authenticated operation. Do not recreate the PVC.
- Stuck deletion: inspect finalizer status and owned Pod, Secret, and PVC individually. Never remove the finalizer until
  owned resources are confirmed absent or deliberately preserved through an incident procedure.
