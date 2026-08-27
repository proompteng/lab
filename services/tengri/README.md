# Tengri MicroVM reconciler

This slice implements the Kubernetes runtime boundary for Tengri. A
`runtime.proompteng.ai/v1alpha1` `MicroVM` is reconciled into exactly one
Firecracker-backed Nanoagent guest and its persistent state:

```text
MicroVM CR -> bootstrap Secret + 16 GiB PVC + kata-fc Pod -> MicroVM status
```

The internal gRPC lifecycle API creates and controls these resources. It is not public: the web BFF
signs every request with a GitHub subject, timestamp, one-use nonce, RPC path, and protobuf body.
Tengri verifies the HMAC and derives the deterministic owner-scoped CR name.

## Lifecycle API

`MicroVMControlPlane` exposes `CreateAgent`, `ListAgents`, `GetAgent`, `WatchAgent`, `SleepAgent`,
`ResumeAgent`, and `DeleteAgent`. Callers provide only a display name; architecture, image, resource
profile, idle deadline, and hard expiry are server policy.

Authentication rejects stale timestamps, replayed nonces, invalid bodies, invalid RPC paths, and
cross-owner agent IDs. A one-key or bounded current/previous HMAC bundle supports safe rotation.
Nonce consumption is persisted in the `tengri-auth-nonces` ConfigMap so replay protection survives
process restarts.

## Runtime contract

- `runtimeClassName: kata-fc`
- digest-pinned Nanoagent image
- fixed 2 CPU, 4 GiB memory, and 16 GiB `rook-ceph-block` workspace
- unprivileged, non-root guest with no service-account token, host namespace, host path, or added
  capability
- proven-runtime and architecture node selection, control-plane tolerations, and topology spreading
- exact `Pending`, `Booting`, `Ready`, `Sleeping`, `Failed`, and `Terminating` status
- Pod deletion after 60 idle minutes while preserving the PVC
- CR, Pod, Secret, and PVC deletion after the four-hour hard expiry
- foreground finalizer cleanup for the Pod, bootstrap Secret, and PVC

The CRD schema rejects mutable image tags and caller-selected resource sizes. Tengri never changes
Talos, RuntimeClasses, node schedulability, or node power state.

## Validation

Run from the repository root:

```bash
cargo fmt --manifest-path services/tengri/Cargo.toml --check
cargo clippy --manifest-path services/tengri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/tengri/Cargo.toml --locked --all-targets
cargo run --manifest-path services/tengri/Cargo.toml --locked --quiet --bin crdgen \
  > /tmp/tengri-crd.yaml
diff -u /tmp/tengri-crd.yaml services/tengri/crd.yaml
```

The unit tests prove the fixed resource profile, unprivileged `kata-fc` Pod projection, persistent
PVC projection, precise scheduling/image/container failures, idle sleep, hard expiry, and finalizer
preservation. Live rollout remains disabled until the later delivery slice pins signed multi-arch
image digests and enables the Argo applications.
