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
copies. `Prune=false,Delete=false` protects the CRD when the application is disabled or removed, preserving existing
`MicroVM` resources and their PVC-owned state.

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
2. Build both multi-architecture images in CI and publish immutable digests to the private registry.
3. Update only the two digest references in `argocd/applications/tengri/kustomization.yaml`.
4. Merge the reviewed PR and let Argo reconcile the application.
5. Verify the controller Deployment, Service endpoints, `/livez`, `/readyz`, and unchanged node scheduling.
6. Run the bounded Firecracker acceptance path: create one authenticated agent, prove `runtimeClassName: kata-fc`,
   guest kernel isolation, fresh-image pull, interactive PTY, persistent file round trip, Codex event, and localhost
   preview WebSocket/HMR.

Do not deploy from a worktree, directly apply rendered manifests, cordon or drain a node, reboot a node, or create a
permanent canary DaemonSet.

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
