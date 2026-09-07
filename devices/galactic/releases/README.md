# Galactic Talos 1.14 and Kubernetes 1.37 rollout

The target is Talos `v1.14.0`, followed by Kubernetes `v1.37.0`. Downtime is authorized. Keep the three existing
machine identities, boot disks, data volumes, provider networking, PodCIDRs, and `maxPods: 500`. Maintain etcd quorum
by upgrading only one control-plane node at a time. Subsequent Omni upgrades use `maxParallelism: 1`. Individual
control-plane nodes cannot be locked; the cluster-wide maintenance lock is supported.

## Transition from the existing custom installers

The current r4/r5 installers contain the required extensions but no Image Factory schematic metadata. All three
machines report `schematic.invalid: true`. Omni 1.11 deliberately generates an empty schematic for these machines
and falls back to the stock Talos installer, even when the template requests extensions. A normal version sync in
that state would lose the GPU and Kata extensions.

For this migration, lock the whole cluster with `omnictl cluster lock galactic` and keep its existing desired version
until the direct installations finish. Omni 1.11 rejects cluster specification changes while the lock remains set;
its template validator also rejects the reserved lock annotation. Do not sync the template or unlock the cluster
during the direct installations. With no active Omni lifecycle operation, use `talosctl` to install each verified factory image in Ryzen,
Turin, Altra order. Drain only the current target, retain its data and identity, stage with `--drain=false --no-reboot`,
then reboot after successful installation. The accepted Altra EFI and Turin BMC recovery procedures still apply.

This single transition installs both Talos 1.14 and the missing factory metadata. Complete each node's acceptance
before proceeding. Once all three report the expected version, valid schematic, and matching installer receipt,
review the template sync dry run: the Cluster update must set Talos to 1.14.0 and remove the maintenance lock together,
while retaining Kubernetes 1.36.4. Sync that committed template so the desired version and lock change in the same
Cluster resource update. Do not unlock separately while Omni still targets 1.13.9. Verify the generated configuration
preserves the extensions and disk identities, then confirm configuration convergence and workload recovery before starting Kubernetes.
Keep the cluster locked if migration or artifact acceptance is incomplete. Future upgrades return to Omni's normal
rolling lifecycle; this exception does not authorize stock installers or changes to controller-owned status resources.

The fallback is explicit in Omni 1.11's
[schematic controller](https://github.com/siderolabs/omni/blob/v1.11.0/internal/backend/runtime/omni/controllers/omni/schematic/configuration.go).

## Artifacts

Use `node-cidr-mask-size-ipv4: "23"` for the IPv4 PodCIDR allocator. Talos 1.14 supplies an IPv4-specific mask by
default; retaining the legacy `node-cidr-mask-size: "23"` produces both flags and prevents the controller manager
from starting. This also stops certificate signing and can leave a rebooted kubelet waiting for its bootstrap CSR.
Persist the IPv4 flag in the shared Omni patch while the cluster is locked. Include that flag replacement in each
node's staged configuration for its Talos 1.14 boot, leaving the running Talos 1.13 configuration unchanged until
restart. If a node has already booted 1.14 with both flags, apply the corrected configuration without another reboot.
Do not change any existing Node PodCIDR. Verify the controller-manager commands contain only the IPv4 flag with
value 23, all controller managers remain running, and pending verified node certificates are issued before proceeding.

The CRI customization entry at `/etc/cri/conf.d/20-customization.part` must use `op: create` on every node. Talos 1.14
does not initially provide that file. `op: overwrite` fails the boot sequence before etcd and trustd start. Talos'
CRI customization controller handles this path specially, so `create` is supported even though ordinary created
files must live under `/var`. Preserve the file's blockfile, image retention, and sandbox settings. The existing
`/etc/cri/containerd.toml` entry continues to use `overwrite`.

For a node still running Talos 1.13.9 during the locked transition, stage the corrected full configuration with
`talosctl apply-config --mode=staged`. Its dry run must show only the CRI operation change and the allocator flag
replacement above, except for changes already present. Immediate `no-reboot` mode rejects the CRI change on 1.13.9.
After the installer finishes, verify that the persistent configuration still contains `op: create` and the IPv4
allocator flag before rebooting; the active configuration retains the old settings until that restart.

[`devices/nuc/image-factory/release.json`](../../nuc/image-factory/release.json) pins the official extension catalog,
the combined catalog digest, and the existing signed Kata `4.1.0-r5` multi-architecture image. The catalog builder
and the deployed factory verification consume this same release lock.
Its extension manifest supports Talos `>= v1.13.0-alpha.2`. The catalog promotes those exact bytes to GHCR and signs
them through the existing trusted Kata workflow. Ryzen already runs r5; this rollout also moves Turin and Altra from
r4 to r5. Their runtime acceptance remains required.

The catalog workflow verifies the source signature and both architectures, builds a catalog with deterministic contents,
and requires its computed image digest to match the release lock. It
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
3. Lock the cluster and verify the lock. Move the imported `machine.install.disk` selections into each template
   Machine's `install.diskSelector` field using its verified, unique disk serial. Omni's static `install.disk` field
   matches an enumerated device path, so use the serial selector to retain disk identity across enumeration changes.
   Preserve the other legacy install options. Omni 1.11 only automatically migrates its
   old generated disk patches; imported multi-purpose patches require this explicit migration. Validate a secret-filled
   temporary template with the existing renderer. If export fails because of the legacy disk fields, retrieve the
   current ConfigPatch resources privately and use their decoded `spec.data` as the renderer's `--secrets-from` input.
   Render the validated template to resources. Apply only the three MachineInstallDiskConfigs, three changed
   imported ConfigPatches, and the shared `20-galactic-podcidr-23` allocator patch while locked, preserving their
   existing metadata. The shared patch replaces the generic mask flag with its IPv4-specific equivalent. Review the
   resource apply dry run and verify that each imported patch only removes its legacy disk field and changes the CRI customization operation from
   `overwrite` to `create`. If either change was already applied, require that state to be retained. Confirm a fresh
   template export now passes. Leave the
   Cluster resource unchanged until all direct installations pass. Keep Kubernetes at `v1.36.4`.
4. Follow the locked custom-installer transition above to install Talos `v1.14.0` on each node. Preserve the existing
   CRI configuration needed for Kata blockfile snapshots. Do not
   enable the new workload-isolation security profile during this upgrade. Preserve Argo-owned Flannel and its MTU.
5. For each node, save an etcd snapshot from a peer, verify the installer receipt, drain, then perform the controlled
   factory transition. If a PodDisruptionBudget prevents the authorized downtime, inspect the affected controllers and use the
   documented PDB bypass. Confirm the node's new Talos version, boot disk, network, PodCIDR, etcd membership, storage,
   GPU, and QEMU/Cloud Hypervisor/Firecracker/Dragonball canaries as it returns. Complete all node and workload acceptance
   and verify Omni convergence after unlocking before starting Kubernetes. Retain the existing
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
