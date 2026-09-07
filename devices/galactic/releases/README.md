# Galactic Talos 1.14 and Kubernetes 1.37 rollout

The target is Talos `v1.14.0`, followed by Kubernetes `v1.37.0`. Downtime is authorized. Keep the three existing
machine identities, boot disks, data volumes, provider networking, PodCIDRs, and `maxPods: 500`. Maintain etcd quorum
through Omni's rolling control-plane upgrade with `maxParallelism: 1`. Omni selects the node order and checks etcd
health between upgrades. Individual control-plane nodes cannot be locked.

## Artifacts

`v1.14.0.json` pins the official extension catalog and the existing signed Kata `4.1.0-r5` multi-architecture image.
Its extension manifest supports Talos `>= v1.13.0-alpha.2`. The catalog promotes those exact bytes to GHCR and signs
them through the existing trusted Kata workflow. Ryzen already runs r5; this rollout also moves Turin and Altra from
r4 to r5. Their runtime acceptance remains required.

The catalog job verifies the source signature and both architectures, builds a catalog with deterministic contents,
then signs the published extension and catalog before making the Talos version tag discoverable. It refuses to replace
an existing version tag with different contents. The `v1.13.9` catalog and accepted installers remain available for
recovery. `catalog.sh build <directory>` can repeat the artifact validation with Crane, Cosign, jq, and GNU tar.

The native Kata regression tests use `nix develop --file devices/galactic/extensions/kata/shell.nix` on Linux, with
Rust 1.96 installed by the workflow. This
provides the compiler, libclang, libmount, libseccomp, protobuf, and packaging tools from the repository's pinned
nixpkgs input. The runner's host package database is not part of the build dependency contract.

Image Factory builds the actual node installers from the new Talos version and each machine's existing extension
selection. Record each schematic, installer index and architecture digest, resolved extension digest, and matching
factory build logs before allowing that node to upgrade. A catalog build alone does not prove its installer.

## Execution order

1. Record the current nodes, etcd members, Ceph, Argo applications, workload failures, Flink jobs, GPUs, and runtime
   versions. Save a fresh cluster etcd snapshot and an offline Omni archive; verify their checksums and retain an
   off-host copy. Back up the Image Factory configuration and signing key without replacing its persistent storage.
2. Deploy the committed Image Factory `v1.6.1` and Omni `v1.11.0` pins. Verify the factory's new catalog and Omni's
   machine connectivity. Omni's database migration requires full-state restoration for rollback, not an image downgrade.
3. Export the live cluster through Omni 1.11. Move the imported `machine.install.disk` selections into each template
   Machine's `install.diskSelector` field using its verified, unique disk serial. Omni's static `install.disk` field
   matches an enumerated device path, so use the serial selector to retain disk identity across enumeration changes.
   Preserve the other legacy install options. Omni 1.11 only automatically migrates its
   old generated disk patches; imported multi-purpose patches require this explicit migration. Validate a secret-filled
   temporary template with the existing renderer and review its dry-run before sync. Keep Kubernetes at `v1.36.4`.
4. Set Talos to `v1.14.0` through the committed Omni template, with rolling `maxParallelism: 1`. Preserve the existing
   CRI configuration needed for Kata blockfile snapshots. Do not
   enable the new workload-isolation security profile during this upgrade. Preserve Argo-owned Flannel and its MTU.
5. For each node, save an etcd snapshot from a peer, verify the installer receipt, drain, then let Omni perform the
   upgrade. If a PodDisruptionBudget prevents the authorized downtime, inspect the affected controllers and use the
   documented PDB bypass. Confirm the node's new Talos version, boot disk, network, PodCIDR, etcd membership, storage,
   GPU, and QEMU/Cloud Hypervisor/Firecracker/Dragonball canaries as it returns. Omni controls progression using its
   readiness and quorum checks; complete all node and workload acceptance before starting Kubernetes. Retain the existing
   Altra EFI and Turin BMC recovery procedures in `docs/runbooks/talos-latest-upgrade-plan.md` for their exact documented
   failure conditions.
6. After all nodes pass, commit and sync the separate Kubernetes `v1.37.0` change through Omni. Verify all three
   apiservers and kubelets, node readiness, DNS and cross-node traffic, Ceph and PVCs, Argo and workload recovery, Flink
   jobs and checkpoint progress, GPU inference, Kata guests, and a real CI runner job. Report pre-existing failures
   separately. Remove temporary maintenance flags and delete secret-filled local exports.

## Recovery

Stop progression on a failed node while the two other etcd members continue serving. Keep the node's current logs,
boot identity and installer receipt. Use the accepted prior installer for that exact machine only through the recorded
recovery procedure; never reset the machine or change its disk selector to an enumerated disk guessed from another boot.
Talos rollback and Kubernetes downgrade have different compatibility constraints: restore from a verified etcd snapshot
only as a deliberate disaster-recovery action after evaluating the live quorum. An Omni rollback restores its entire
pre-upgrade archive together with the previous pinned image.

Primary references: [Talos 1.14 release](https://github.com/siderolabs/talos/releases/tag/v1.14.0),
[Talos support matrix](https://docs.siderolabs.com/talos/v1.14/getting-started/support-matrix),
[Omni 1.11 release](https://github.com/siderolabs/omni/releases/tag/v1.11.0), and
[Image Factory 1.6.1 release](https://github.com/siderolabs/image-factory/releases/tag/v1.6.1).
