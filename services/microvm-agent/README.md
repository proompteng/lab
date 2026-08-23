# MicroVM agent canary

`microvm-agent` is a small, long-running, multi-architecture process used to prove the `kata-qemu`, `kata-clh`,
`kata-fc`, and `kata-dragonball` workload paths. It is not an AgentRun runtime and does not require a custom
Kubernetes controller.

The process requires `MICROVM_ID` and `MICROVM_BOOTSTRAP_TOKEN`. Kubernetes sends both through CRI as environment
variables, so the Pod does not depend on host filesystem sharing. The checked-in runtime canaries use a fixed,
non-secret proof nonce; production agents must resolve credentials from a Kubernetes Secret. The agent never returns
or logs the token. It reports only its SHA-256 digest alongside the guest boot ID, guest kernel release and
architecture.

Endpoints:

- `GET /healthz`: readiness and liveness check;
- `GET /evidence`: non-secret guest evidence used by the rollout verifier.

Run locally:

```bash
MICROVM_ID=local MICROVM_BOOTSTRAP_TOKEN=development-only go run .
```

The release workflow publishes and keylessly signs `ghcr.io/proompteng/microvm-agent` for `linux/amd64` and
`linux/arm64`. Kubernetes manifests must use the resulting multi-architecture digest, never a mutable tag.
