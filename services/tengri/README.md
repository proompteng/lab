# Tengri control plane

Tengri is the standalone Rust owner of `runtime.proompteng.ai/v1alpha1 MicroVM` resources. It accepts only signed,
authenticated internal gRPC calls, derives one deterministic MicroVM name per GitHub subject, and projects each CR into
an unprivileged `kata-fc` Pod with a 16 GiB persistent home PVC.

The control plane also brokers scoped, one-use terminal tickets and localhost preview sessions. It does not run inside
the guest and does not use AgentRun, KubeVirt, host devices, privileged launchers, or node mutations.

`TENGRI_INTERNAL_HMAC_SECRET` normally contains one base64url key of at least 32 bytes. Rotate it without an
authentication outage by publishing `new,current` in the same 1Password field first: the BFF signs with both keys and
the controller accepts either while the two ExternalSecrets refresh independently. After both workloads observe the
bundle, remove the previous key. More than two keys are rejected.

Every valid signed request atomically consumes a hashed replay receipt in the pre-provisioned
`tengri-auth-nonces` ConfigMap. Kubernetes `resourceVersion` compare-and-swap makes replay rejection consistent across
controller restarts and overlapping rollout Pods; only live receipts are retained and the bounded store fails closed.
The deployment RBAC grants only `get` and `update` on that named ConfigMap.

## Local validation

```bash
cd services/tengri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
cargo run --quiet --bin crdgen
```

Runtime configuration is documented in `docs/tengri/operations.md`. The protobuf contract is
`proto/proompteng/runtime/v1/microvm.proto`.
