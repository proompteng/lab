# Tengri control plane

Tengri is the standalone Rust owner of `runtime.proompteng.ai/v1alpha1 MicroVM` resources. It accepts only signed,
authenticated internal gRPC calls, derives one deterministic MicroVM name per GitHub subject, and projects each CR into
an unprivileged `kata-fc` Pod with a 16 GiB persistent home PVC.

The control plane also brokers scoped, one-use terminal tickets and localhost preview sessions. It does not run inside
the guest and does not use AgentRun, KubeVirt, host devices, privileged launchers, or node mutations.

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
