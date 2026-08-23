# Kata 4.1.0 / Talos v1.13.9 release receipt

Recorded on 2026-08-23. This receipt separates published artifact proof from the live Galactic node rollout.

## Source and workflows

- Runtime extension, catalog, and installers source: `c579c23f4ad6ecb110547078e69ea2895f49a837`.
- Runtime workflow: [Kata multi-runtime Talos extension run 32631832925](https://github.com/proompteng/lab/actions/runs/32631832925), successful.
- Agent source: `ffebebfcf0bf4f11b8f0e44614749f08ed07e8d9`.
- Agent workflow: [MicroVM agent run 32631290227](https://github.com/proompteng/lab/actions/runs/32631290227), successful.

## Immutable artifacts

| Artifact | Platform | Immutable reference |
| --- | --- | --- |
| Kata runtime extension | `linux/amd64`, `linux/arm64` | `ghcr.io/proompteng/talos-kata-runtimes@sha256:48f88ef0f3f5941aa031a56e47879bf894b8013df8d3861134ee300149511c70` |
| Combined Talos extension catalog | OCI manifest | `ghcr.io/proompteng/talos-extensions@sha256:e0052fe1a75bbb0daf62a33641d4f785bb9d3e93bbfb735c5ce74cf7bd269fd9` |
| Ryzen installer | `linux/amd64` | `ghcr.io/proompteng/talos-kata-runtimes@sha256:485d7b4b4ed851ab4d9eaa2700f3b472c74dcaa29875cd05f4a084c6f95b31f1` |
| Turin installer | `linux/amd64` | `ghcr.io/proompteng/talos-kata-runtimes@sha256:c4104c2df9c0cd5cdfacb08bed9c155fde01358760a5a0cb7f7a0d529da19fb2` |
| Altra installer | `linux/arm64` | `ghcr.io/proompteng/talos-kata-runtimes@sha256:47c5834f0951314727fa3aafb70d955f62f0a3d22239bd385da5dffbc9e17db0` |
| Long-running microVM agent | `linux/amd64`, `linux/arm64` | `ghcr.io/proompteng/microvm-agent@sha256:5573551391d01240297680da6ac172d3c819b57d493c3c3e2e11fa1388b06640` |

All six references passed keyless Cosign verification against GitHub Actions OIDC. The extension, catalog, and
installers use identity
`https://github.com/proompteng/lab/.github/workflows/kata-firecracker-extension.yaml@refs/heads/main`; the agent uses
`https://github.com/proompteng/lab/.github/workflows/microvm-agent.yaml@refs/heads/main`. Both use issuer
`https://token.actions.githubusercontent.com`.

The catalog has 84 entries and contains exactly this custom entry:

```text
ghcr.io/proompteng/talos-kata-runtimes:4.1.0-talos-v1.13.9@sha256:48f88ef0f3f5941aa031a56e47879bf894b8013df8d3861134ee300149511c70
```

## NUC Image Factory handoff

The digest-pinned community Image Factory `v1.5.0` and its private registry are running on the NUC. Live verification
passed at `http://100.100.244.148:8081` with the custom extension digest above. A schematic smoke request produced
`2e2b452f790f45e5cc3be7e1fd6bf2fa5124b48454a908dd288aea898288c103`.

Omni is running with the repository configuration and the NUC file has SHA-256
`73547d0ccdfb7071d5f94b2779fe03067b768a2d754c0b39d67d06d472217ac5`. The primary factory is the provider-LAN
endpoint, not Tailscale. Port `8081` is intentional because Pi-hole owns port `8080` on the NUC.

## Live rollout status

Artifact publication and Image Factory installation are complete. Node installation and VMM proof are not complete.
The rollout remains stopped before any Talos node reboot because Ceph is `HEALTH_WARN` with `nobackfill,norecover`,
250 degraded placement groups, and 227 undersized placement groups. All three Kubernetes nodes are currently Ready and
schedulable on Kubernetes `v1.36.4`; all three etcd members are healthy non-learners.

Do not describe the runtimes as working on Galactic until the following evidence exists:

1. Ceph has six up/in OSDs, three monitors, every placement group is active and clean, and no recovery-suppression flags.
2. Omni has applied `image-factory-registry.yaml` to all three nodes without a pending configuration error.
3. Omni has installed the architecture-specific images sequentially in the order Ryzen, Turin, Altra with
   `maxParallelism: 1`, passing the runbook gates before each node.
4. Each runtime-specific node label has been activated independently and `verify-runtimes.sh` has captured guest boot,
   guest kernel, CRI sandbox, and host-side VMM evidence for QEMU, Cloud Hypervisor, Firecracker, and Dragonball.

The RuntimeClasses and canary DaemonSets are intentionally inert until those labels are applied.
