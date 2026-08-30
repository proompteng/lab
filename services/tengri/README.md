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

Public HTTP traffic is split across two listeners with separate routers and Kubernetes Services. Port `8080` exposes
only Tengri-owned control routes such as terminal WebSockets, preview-session opening, probes, and metrics. Port `8081`
exposes only session-host bootstrap assets and the authenticated guest preview proxy. Traefik routes
`tengri.proompteng.ai` control paths to `tengri-gateway:8080` and session hosts to `tengri-preview:8081`; observability
can reach only the control listener. A guest application may therefore own paths such as `/metrics` or `/healthz`
without those requests reaching Tengri's own handlers.

`/livez` reports process liveness. `/readyz` and the compatibility `/healthz` alias report success only while the
Kubernetes control path and in-process ticket state are usable; deployment probes do not advertise an isolated process
as ready to accept agent operations.

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

## GitOps rollout and rollback

Tengri is a singleton `Recreate` Deployment. A GitOps rollout terminates the old control-plane Pod before the new Pod
becomes ready, so gRPC, event streams, PTY WebSockets, and preview proxy connections are briefly unavailable. Existing
MicroVM Pods and PVCs continue running; this rollout does not modify a `MicroVM`, Kata, Talos, or any cluster node.
Clients reconnect after the Service has a ready endpoint, while an operation submitted during the gap returns a
truthful service-unavailable response and must be retried.

Roll out through the `Tengri images` publisher, Kargo, and Argo reconciliation. On `main`, `Tengri images` validates
both services, builds native `linux/amd64` and `linux/arm64` images, publishes signed multi-architecture indexes at
`registry.ide-newton.ts.net/lab/{tengri,nanoagent}:kargo-sha-<40>` only after each final index succeeds; the images
carry `org.opencontainers.image.created` (source commit RFC3339 time) and `org.opencontainers.image.revision` (full
source SHA), and their immutable digests are uploaded in the `tengri-release-contract` artifact. The Kargo `tengri` Stage consumes the controller and Nanoagent Freight together,
copies the exact source commit and full digest/build metadata to `kargo/tengri`, and pushes that branch without a pull
request. The Argo Applications track the generated branch; no promotion PR or manifest SHA bump is required:

1. Merge the controller or guest source and wait for `Tengri images` validation, both native builds, index publication,
   and keyless signature verification to pass.
2. In `lab-delivery`, verify that Kargo discovered both immutable images, created the matching Freight, and promoted the
   exact automatic `tengri` Stage. Verify that `kargo/tengri` contains the complete source commit, digests, and build
   provenance, and that the Argo Applications track it at `Synced`/`Healthy`.
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

If the replacement cannot become ready, inspect the Kargo Stage, Freight, generated `kargo/tengri` branch, and Argo
Applications and correct the source-owned failure. Re-promote a previously proven controller/guest Freight pair through
Kargo; never use `kubectl rollout undo`, directly apply manifests, or create a digest promotion PR. Never revert to a controller predating
`home-workspace-v2` while any v2 `MicroVM` exists: the predecessor cannot safely resume those guests. Let every v2 agent
expire or delete it through Tengri, verify that no v2 CR remains, and only then re-promote the matching known-good pair.
Verify the restored Pod, Service endpoint, `/livez`, and `/readyz` with the commands above.

Tengri supports one storage layout:
`runtime.proompteng.ai/storage-layout=home-workspace-v2`. Every new agent receives that annotation and one 16 GiB
`volumeMode: Block` PVC. The Pod exposes it as `/dev/tengri-home`; the reviewed Kata persistent-block contract formats
a provably new device once, mounts it at `/home/nanoagent`, applies GID 1000, and reuses the same filesystem on later
boots. Nanoagent exposes the persistent `workspace/` subdirectory through `/workspace`. There is one application
container and no init container.

The Pod requires both `runtime.proompteng.ai/kata-fc=ready` and
`runtime.proompteng.ai/kata-fc-persistent-block=ready`. The second capability must be applied only after the signed r5
Kata extension is installed and its raw-block persistence acceptance passes on that node. Stock r4 nodes are
deliberately ineligible rather than receiving a Pod whose PVC would be copied into Firecracker's 512 MiB rootfs.

The failed `home-workspace-v1` experiment never produced a working guest and is not a compatibility contract. A CR with
any other layout is rejected and must be deleted and recreated; Tengri does not migrate or fall back to the broken
topology. A v2 CR backed by a legacy filesystem-mode claim is also rejected and must be deleted and recreated; the
controller never mutates or reformats that claim. Never roll back past the v2 controller while a v2 CR exists.

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
