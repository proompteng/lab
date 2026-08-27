# Tengri control plane

Tengri is the standalone Rust owner of `runtime.proompteng.ai/v1alpha1 MicroVM` resources. It accepts only signed,
authenticated internal gRPC calls, derives one deterministic MicroVM name per GitHub subject, and projects each CR into
an unprivileged `kata-fc` Pod with a 16 GiB persistent home PVC.

The control plane also brokers scoped, one-use terminal tickets and localhost preview sessions. It does not run inside
the guest and does not use AgentRun, KubeVirt, host devices, privileged launchers, or node mutations.

Each Chrome preview load exchanges its one-use ticket for a bounded, owner-scoped session whose ID is allocated before
the browser receives the ticket. The desktop revokes both unused tickets and active sessions when a preview is
superseded or closed, so reload and history use cannot exhaust the per-agent session limit. The gateway injects a
nonce-authorized navigation bridge into uncompressed HTML responses; the desktop accepts navigation and shortcut
events only from the exact issued preview origin and iframe. This keeps the virtual address bar, history, reload, and
Chrome shortcuts synchronized without exposing the session token to guest applications.

`/livez` reports process liveness. `/readyz` and the compatibility `/healthz` alias report success only while the
Kubernetes control path and in-process ticket state are usable; deployment probes do not advertise an isolated process
as ready to accept agent operations.

`TENGRI_INTERNAL_HMAC_SECRET` normally contains one base64url key of at least 32 bytes. Rotate it without an
authentication outage by publishing `new,current` in the same 1Password field first: the BFF signs with both keys and
the controller accepts either while the two ExternalSecrets refresh independently. After both workloads observe the
bundle, remove the previous key. More than two keys are rejected.

Every valid signed request atomically consumes a hashed replay receipt in the pre-provisioned
`tengri-auth-nonces` ConfigMap. Kubernetes `resourceVersion` compare-and-swap makes replay rejection consistent across
controller restarts. The singleton serializes nonce updates before entering the Kubernetes compare-and-swap loop, and
bounded exponential retry absorbs an external write conflict without rejecting an ordinary burst of valid requests.
Only live receipts are retained and the bounded store fails closed. The deployment RBAC grants only `get` and `update`
on that named ConfigMap.

## GitOps rollout and rollback

Tengri is a singleton `Recreate` Deployment. A GitOps rollout terminates the old control-plane Pod before the new Pod
becomes ready, so gRPC, event streams, PTY WebSockets, and preview proxy connections are briefly unavailable. Existing
MicroVM Pods and PVCs continue running; this rollout does not modify a `MicroVM`, Kata, Talos, or any cluster node.
Clients reconnect after the Service has a ready endpoint, while an operation submitted during the gap returns a
truthful service-unavailable response and must be retried.

Roll out only through the `Tengri images` publisher, the generated `Tengri release` promotion PR, and Argo
reconciliation. On `main`, `Tengri images` validates both services, builds native `linux/amd64` and `linux/arm64`
images, publishes signed multi-architecture indexes at `registry.ide-newton.ts.net/lab/{tengri,nanoagent}:sha-<commit>`,
and uploads their immutable digests in the `tengri-release-contract` artifact. `Tengri release` verifies that contract,
both OCI indexes, and both signatures, then opens one atomic promotion PR that pins both digests and enables the
ApplicationSet and BFF together:

1. Merge the controller or guest source and wait for `Tengri images` validation, both native builds, index publication,
   and keyless signature verification to pass.
2. Review and merge the generated promotion PR; never hand-edit a mutable tag into GitOps.
3. Confirm Argo starts one `tengri` Deployment replacement and does not reconcile guest Pods, PVCs, or nodes.
4. From a configured `galactic-lan` client, verify the replacement and its control path:

   ```bash
   set -euo pipefail

   kubectl --context galactic-lan -n tengri rollout status deployment/tengri --timeout=5m
   kubectl --context galactic-lan -n tengri get pods -l app.kubernetes.io/name=tengri -o wide
   kubectl --context galactic-lan -n tengri get endpointslice -l kubernetes.io/service-name=tengri-grpc
   kubectl --context galactic-lan -n tengri port-forward service/tengri-gateway 18080:8080 &
   tengri_port_forward_pid=$!
   trap 'kill "$tengri_port_forward_pid" 2>/dev/null || true' EXIT INT TERM
   for tengri_attempt in {1..30}; do
     if curl --fail --silent --output /dev/null http://127.0.0.1:18080/livez; then
       break
     fi
     sleep 1
   done
   curl --fail --silent --show-error http://127.0.0.1:18080/livez
   curl --fail --silent --show-error http://127.0.0.1:18080/readyz
   kill "$tengri_port_forward_pid"
   wait "$tengri_port_forward_pid" 2>/dev/null || true
   trap - EXIT INT TERM
   ```

5. Confirm the pre-rollout `MicroVM` count and phases are unchanged, then exercise one authenticated read-only control
   plane request. Do not create a canary DaemonSet or mutate node scheduling to verify this rollout.

If the replacement cannot become ready, revert the manifest or image-digest commit through a follow-up PR and let Argo
perform the same `Recreate` rollout to the last known-good revision. Do not use `kubectl rollout undo` or directly apply
manifests because GitOps would overwrite that state. During rollback, leave existing MicroVM Pods and PVCs intact;
verify the restored Pod, Service endpoint, `/livez`, and `/readyz` with the same commands above.

## GitOps rollout and rollback

Tengri is a singleton `Recreate` Deployment. A GitOps rollout terminates the old control-plane Pod before the new Pod
becomes ready, so gRPC, event streams, PTY WebSockets, and preview proxy connections are briefly unavailable. Existing
MicroVM Pods and PVCs continue running; this rollout does not modify a `MicroVM`, Kata, Talos, or any cluster node.
Clients reconnect after the Service has a ready endpoint, while an operation submitted during the gap returns a
truthful service-unavailable response and must be retried.

Roll out only through the normal image workflow and Argo reconciliation:

1. Merge the reviewed manifest and digest update after focused controller, Kustomize, and schema validation passes.
2. Confirm Argo starts one `tengri` Deployment replacement and does not reconcile guest Pods, PVCs, or nodes.
3. From a configured `galactic-lan` client, verify the replacement and its control path:

   ```bash
   set -euo pipefail

   kubectl --context galactic-lan -n tengri rollout status deployment/tengri --timeout=5m
   kubectl --context galactic-lan -n tengri get pods -l app.kubernetes.io/name=tengri -o wide
   kubectl --context galactic-lan -n tengri get endpointslice -l kubernetes.io/service-name=tengri-grpc
   kubectl --context galactic-lan -n tengri port-forward service/tengri-gateway 18080:8080 &
   tengri_port_forward_pid=$!
   trap 'kill "$tengri_port_forward_pid" 2>/dev/null || true' EXIT INT TERM
   for tengri_attempt in {1..30}; do
     if curl --fail --silent --output /dev/null http://127.0.0.1:18080/livez; then
       break
     fi
     sleep 1
   done
   curl --fail --silent --show-error http://127.0.0.1:18080/livez
   curl --fail --silent --show-error http://127.0.0.1:18080/readyz
   kill "$tengri_port_forward_pid"
   wait "$tengri_port_forward_pid" 2>/dev/null || true
   trap - EXIT INT TERM
   ```

4. Confirm the pre-rollout `MicroVM` count and phases are unchanged, then exercise one authenticated read-only control
   plane request. Do not create a canary DaemonSet or mutate node scheduling to verify this rollout.

If the replacement cannot become ready, revert the manifest or image-digest commit through a follow-up PR and let Argo
perform the same `Recreate` rollout to the last known-good revision. Do not use `kubectl rollout undo` or directly apply
manifests because GitOps would overwrite that state. During rollback, leave existing MicroVM Pods and PVCs intact;
verify the restored Pod, Service endpoint, `/livez`, and `/readyz` with the same commands above.

## Local validation

```bash
cargo fmt --manifest-path services/tengri/Cargo.toml --check
cargo clippy --manifest-path services/tengri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/tengri/Cargo.toml --locked --all-targets
cargo run --manifest-path services/tengri/Cargo.toml --locked --quiet --bin crdgen \
  > /tmp/tengri-crd.yaml
diff -u /tmp/tengri-crd.yaml services/tengri/crd.yaml
```

Runtime configuration is documented in [`../../docs/tengri/operations.md`](../../docs/tengri/operations.md). The
protobuf contract is [`proto/proompteng/runtime/v1/microvm.proto`](proto/proompteng/runtime/v1/microvm.proto).
