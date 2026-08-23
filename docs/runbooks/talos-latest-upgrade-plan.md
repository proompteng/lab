# Galactic Talos, Kubernetes, and Kata rollout

This is the production runbook for the three-control-plane `galactic` cluster. Omni owns machine configuration and
Talos/Kubernetes upgrades. Argo CD owns Kubernetes resources. The rollout installs one signed Kata Containers system
extension that exposes QEMU, Cloud Hypervisor, Firecracker, and Dragonball without a custom controller, CRD,
privileged launcher, AgentRun, or KubeVirt.

## Pinned targets

| Component | Target | Source of truth |
| --- | --- | --- |
| Talos | `v1.13.9` | [Talos release](https://github.com/siderolabs/talos/releases/tag/v1.13.9) |
| Kubernetes | `v1.36.4` | [Kubernetes release](https://github.com/kubernetes/kubernetes/releases/tag/v1.36.4) |
| Kata Containers | `4.1.0` | [Kata release](https://github.com/kata-containers/kata-containers/releases/tag/4.1.0) |
| Firecracker | `1.12.1` | bundled by the Kata `4.1.0` release |
| Image Factory | `v1.5.0` | [Image Factory release](https://github.com/siderolabs/image-factory/releases/tag/v1.5.0) |

The version pins, image digests, extension catalog, and node-specific installer profiles are code-reviewed in this
repository. Do not replace them with a floating `latest` tag during a rollout.

Primary operational references:

- [Omni cluster upgrades](https://docs.siderolabs.com/omni/cluster-management/upgrading-clusters)
- [Omni cluster templates](https://docs.siderolabs.com/omni/reference/cluster-templates)
- [Self-hosted Image Factory](https://docs.siderolabs.com/omni/self-hosted/run-image-factory-on-prem)
- [Talos boot assets and system extensions](https://docs.siderolabs.com/talos/v1.13/platform-specific-installations/boot-assets)
- [Kata virtualization design](https://github.com/kata-containers/kata-containers/blob/main/docs/design/virtualization.md)
- local runtime documentation: `devices/galactic/extensions/kata-firecracker/README.md`
- local Image Factory documentation: `devices/nuc/image-factory/README.md`

## Cluster inventory

The addresses below are Elauwit provider-LAN addresses, not Tailscale addresses:

| Machine | Kubernetes node | Architecture | Talos API | Omni machine UUID |
| --- | --- | --- | --- | --- |
| Ryzen | `talos-192-168-1-194` | `amd64` | `100.100.244.141` | `ff115a00-c307-11f0-a28f-648eab3e4100` |
| Turin | `turin` | `amd64` | `100.100.244.190` | `8bf7ec00-171c-11f1-8000-7cc255f16774` |
| Altra | `talos-192-168-1-85` | `arm64` | `100.100.244.142` | `12345678-9abc-deff-1234-56789abcdeff` |

Expected final extension sets:

| Machine | Required extensions |
| --- | --- |
| Ryzen | AMDGPU, AMD microcode, glibc, Tailscale, `talos-kata-runtimes` |
| Turin | NVIDIA LTS kernel modules and toolkit, Tailscale, `talos-kata-runtimes` |
| Altra | NVIDIA LTS kernel modules and toolkit, Tailscale, `talos-kata-runtimes` |

The custom extension replaces the stock Kata extension. Never install both on the same node.

## Signed artifact chain

The main-branch workflows create the immutable inputs:

1. `.github/workflows/kata-firecracker-extension.yaml` builds
   `ghcr.io/proompteng/talos-kata-runtimes:4.1.0-talos-v1.13.9` for `linux/amd64` and `linux/arm64`.
2. The workflow signs and verifies the multi-architecture digest with the exact main-branch GitHub Actions identity.
3. It copies the full official `v1.13.9` extension catalog, appends the digest-pinned custom extension, publishes
   `ghcr.io/proompteng/talos-extensions:v1.13.9`, and signs that immutable catalog digest.
4. It builds and signs independent `ryzen-amd64`, `turin-amd64`, and `altra-arm64` installer receipts. These prove
   that every architecture-specific extension combination can be assembled.
5. `.github/workflows/microvm-agent.yaml` publishes and signs the `linux/amd64` and `linux/arm64` canary agent.
6. GitOps canary images must use the published agent digest, never a mutable tag.

Before touching a node, retain the workflow URLs, image digests, Cosign verification output, and generated installer
digests in the rollout evidence directory.

## One-time Image Factory handoff

The public factory cannot consume an arbitrary private extension catalog. The NUC therefore runs the community Image
Factory and a private backing registry from `devices/nuc/image-factory`.

1. Publish and verify the signed combined catalog.
2. Copy the checked-in Image Factory directory to `/home/kalmyk/image-factory` on the NUC.
3. Create `.env` from `.env.example`, then run `./bootstrap.sh`.
4. Require `./validate.sh` and `./verify.sh` to pass.
5. Deploy the checked-in `devices/nuc/omni/omni.yaml` to `/home/kalmyk/omni/omni.yaml`.
6. Restart only the Omni service and verify that its primary factory is
   `http://100.100.244.148:8081/`.

The factory catalog accepts only official Sidero Labs signing identities and the exact main-branch Kata workflow.
Its cache-signing key and registry state under `/var/lib/image-factory` are persistent and must be backed up.

## Export and review Omni desired state

Authenticate `omnictl`, export the live template, and commit the exact export before changing it:

```bash
omnictl cluster template export galactic \
  --include-kernel-args \
  --output devices/galactic/omni/cluster-template.yaml \
  --force

omnictl cluster template validate \
  --file devices/galactic/omni/cluster-template.yaml
```

Preserve every existing machine patch and extension. Confirm that the control-plane machine set has a rolling upgrade
strategy with `maxParallelism: 1`.

Apply the registry transport configuration as a separate phase before changing any schematic. In the exported
`kind: Cluster` document, add the checked-in file as a cluster-wide config patch (file paths are resolved relative to
the template), then preview and sync:

```yaml
patches:
  - file: image-factory-registry.yaml
```

```bash
omnictl cluster template sync \
  --file devices/galactic/omni/cluster-template.yaml \
  --dry-run \
  --verbose

omnictl cluster template sync \
  --file devices/galactic/omni/cluster-template.yaml \
  --verbose
```

Wait until all three machines report the registry config applied with no pending configuration update. Verify that
each node can reach `http://100.100.244.148:8081` before adding `proompteng/talos-kata-runtimes` to the three
`systemExtensions` lists. Do not use a `machine.install.image` patch: Omni derives the desired installer from each
machine's schematic and selected system extensions.

Preview and sync the extension change only after the registry phase is complete.

## Hard safety gates

Run the checked-in preflight immediately before every individual node:

```bash
export NODE='<kubernetes-node>'
export EVIDENCE_DIR="/tmp/galactic-kata-${NODE}-$(date -u +%Y%m%dT%H%M%SZ)"
devices/galactic/extensions/kata-firecracker/preflight-node.sh "$NODE" "$EVIDENCE_DIR"
```

The script must prove all of the following:

1. the Kubernetes API is ready and the target node is `Ready` and schedulable;
2. etcd has three healthy non-learner members;
3. `/dev/kvm` exists on the target;
4. all six Ceph OSDs are up and in, all three monitors have quorum, and no placement group is degraded, undersized,
   remapped, recovering, backfilling, inactive, down, stale, incomplete, inconsistent, or unknown;
5. Ceph has no `noout`, `norecover`, `nobackfill`, or `pause` flag;
6. a server-side Kubernetes drain dry-run succeeds.

Any failed gate stops the rollout. Do not clear Ceph flags, bypass a PDB, force a drain, delete storage Pods, remove an
etcd member, or reset a node to make the gate green. Fix the owning system first and rerun the complete preflight.

At the time this runbook was authored, live Ceph was `HEALTH_WARN` with degraded, undersized, and remapped placement
groups plus `nobackfill,norecover`. That is a hard blocker; publishing and merging may proceed, but no Talos
installer reboot may start until fresh evidence passes.

## Sequential rollout

Roll out in this fixed order:

1. Ryzen: `talos-192-168-1-194`
2. Turin: `turin`
3. Altra: `talos-192-168-1-85`

For each node:

1. Ensure the other two machines are locked in Omni and the target is the only machine eligible for an operation.
2. Run and retain the complete preflight evidence.
3. Unlock the target and let Omni perform its normal cordon, drain, installer upgrade, reboot, and health checks.
4. Do not run a competing manual `talosctl upgrade`.
5. Wait for the target to return on Talos `v1.13.9`, Kubernetes `v1.36.4`, `Ready`, and schedulable.
6. Verify the expected node-specific AMD/NVIDIA, glibc, Tailscale, and Kata extensions.
7. Verify Kubernetes API readiness, three-member etcd health, and clean Ceph state again.
8. Lock the completed machine before allowing the next target to start.

Do not unlock two control-plane machines simultaneously. If Omni leaves a failed target cordoned, diagnose the
current failure first; uncordon only after the attempted operation is no longer running and the node is healthy.

## Runtime activation and proof

Argo CD application `kata-runtimes` owns four node-gated RuntimeClasses:

| RuntimeClass | VMM | Required node label |
| --- | --- | --- |
| `kata-qemu` | QEMU | `runtime.proompteng.ai/kata-qemu=ready` |
| `kata-clh` | Cloud Hypervisor | `runtime.proompteng.ai/kata-clh=ready` |
| `kata-fc` | Firecracker | `runtime.proompteng.ai/kata-fc=ready` |
| `kata-dragonball` | Dragonball | `runtime.proompteng.ai/kata-dragonball=ready` |

Installing the handlers does not schedule a canary. Activate one runtime on one node at a time:

```bash
kubectl --context galactic-lan label node "$NODE" \
  runtime.proompteng.ai/kata-qemu=ready --overwrite
```

Repeat for `kata-clh`, `kata-fc`, and `kata-dragonball` only after the preceding canary passes. Each long-running
canary is a native Kubernetes Pod using `runtimeClassName`; it is not a privileged launcher. Collect the full proof:

```bash
export PROOF_DIR="/tmp/galactic-kata-proof-$(date -u +%Y%m%dT%H%M%SZ)"
devices/galactic/extensions/kata-firecracker/verify-runtimes.sh "$PROOF_DIR" "$NODE" qemu
```

Use `clh`, `fc`, or `dragonball` for the next individual activation. After all four labels pass on all three nodes,
run the verifier without filters for the final twelve-combination evidence bundle.

Acceptance requires, for every runtime on every architecture:

1. the expected RuntimeClass and independent scheduling label;
2. exactly one Ready canary Pod on the target, using the digest-pinned agent image;
3. guest evidence with a non-empty boot ID and kernel release matching the node architecture;
4. a Talos CRI sandbox corresponding to the Pod;
5. the expected host process: `qemu-system-*`, `cloud-hypervisor`, or `firecracker`;
6. for Dragonball, the built-in runtime-rs shim and Dragonball configuration, because it intentionally has no separate
   VMM process;
7. no plaintext bootstrap proof nonce in agent logs.

The canaries remain running for inspection. If a runtime fails, remove only its activation label:

```bash
kubectl --context galactic-lan label node "$NODE" \
  runtime.proompteng.ai/kata-fc-
```

## Rollback boundaries

- A failed RuntimeClass canary: remove that runtime's node label and inspect the retained evidence. No node reboot is
  required.
- A failed Talos installer rollout: keep the machine locked, preserve Omni and Talos logs, and restore the previously
  proven schematic through Omni only after Kubernetes, etcd, and Ceph gates pass.
- A failed Image Factory deployment: restore the previous `omni.yaml` primary factory and restart Omni; do not point
  machines at a partially verified catalog.
- Never roll back by resetting a machine, deleting an etcd member, purging an OSD, bypassing PDBs, or changing disks
  without a separate recovery plan and explicit authorization.

Completion means the signed artifacts and exact configuration are merged, all three sequential installer operations
have passed the hard gates, and all twelve node/runtime combinations have fresh guest and host-side evidence.
