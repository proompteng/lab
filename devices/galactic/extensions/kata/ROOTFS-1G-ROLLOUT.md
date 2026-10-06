# Firecracker 1 GiB rootfs preparation

This prepares Kata r6 for Nanoagent PR14781's image-time developer tools. It does not authorize host maintenance.
Keep the larger Nanoagent image unpublished until every eligible Firecracker host and its existing cache passes
the 1 GiB gate. Do not reset a user VM or alter its home/PVC to test this release.

## Changes and artifact gates

The extension changes only the root scratch size/explicit ext4 geometry and its r6 version. Runtime handlers,
security, networking, identity, guest memory, and the persistent 16 GiB home remain configured as before.
Installer inputs preserve the currently installed Talos 1.14.0 and official extension digests from the locked
Talos 1.14 catalog. Existing installed receipts and the active factory catalog remain unchanged in this preparation.

PR builds produce native AMD64/ARM64 OCI archives with build-time template checks, patched Kata tests and an offline
512 MiB cached-parent growth/restore test. These archives are unsigned review artifacts. Main-only publication
produces signed r6 extension/installers; it does not install them on a host. Before any maintenance approval,
record that exact main head, workflow/run, extension index and both platform digests, and all three signed installer
digests. Retain the current r5 factory installer indexes/platform manifests from
[`../../releases/talos-v1.14.0.json`](../../releases/talos-v1.14.0.json) and download recovery artifacts off-node.
Use the current [same-schematic replacement procedure](../../releases/README.md#same-schematic-artifact-replacement).
The legacy Talos 1.13.9 receipts are not rollback targets for these hosts.

## Read-only inventory, 2026-10-06 02:10–02:19 UTC

All three Kubernetes nodes report Ready, Talos 1.14.0, containerd 2.3.4, and ready Firecracker/persistent-block labels.
Running Pod counts include system workloads and are a maintenance impact snapshot, not a prediction of evictions.

| Host  | Node                | Talos API       | Architecture | Running Pods | Allocatable ephemeral storage |
| ----- | ------------------- | --------------- | ------------ | -----------: | ----------------------------: |
| Ryzen | talos-192-168-1-194 | 100.100.244.141 | amd64        |           73 |            179542345021 bytes |
| Turin | turin               | 100.100.244.190 | amd64        |          248 |           3682977987016 bytes |
| Altra | talos-192-168-1-85  | 100.100.244.142 | arm64        |          149 |            268974865987 bytes |

No running kata-fc Pod appeared in this inventory. The Tengri controller runs on Turin. Several PDBs, including
Tengri and singleton database primaries, permit zero disruptions. Ceph reports Ready/HEALTH_WARN; classify its
specific warning and recovery safety at preflight. Do not infer free host disk space from allocatable storage.

Actual scratch/snapshot sizes, allocated bytes, loop mounts, and host disk free space remain **unverified**.
The delegated environment has Kubernetes read access but no Talos configuration/client or readable host cache
through the existing host-metrics Pods. Do not create a privileged inspector or change access/security settings
under preparation authority. Before maintenance approval, an existing authorized host operator must capture:

- the installed extension version, bundled template size, and ext4 geometry;
- `/var/lib/containerd/io.containerd.snapshotter.v1.blockfile/scratch`, `metadata.db`, and each regular numeric
  file directly under `snapshots/`: byte size, allocated bytes, inode, ownership, mode, link count and filesystem UUID;
- matching containerd namespace/snapshot records and all running sandboxes/tasks; mounted/loop-attached files;
- free bytes/inodes on the host filesystem and backup destination, and the backup volume's location and restore access.

The [containerd 2.3.4 implementation](https://github.com/containerd/containerd/blob/v2.3.4/plugins/snapshots/blockfile/blockfile.go)
retains existing `scratch` when `recreate_scratch=false` and copies cached parent blockfiles for new snapshots.
Changing only the template or enabling scratch recreation leaves cached parents at 512 MiB. Numeric snapshots are
regular files, not `snapshots/<id>/fs`. Keep containerd metadata/IDs and its configured root path intact.

## Proposed disruptive stages — separate approval required

Use Ryzen, Turin, Altra order, one node at a time, following the current cluster runbook. Run the coordinator
outside the target node; Turin hosts agents-shell, Tengri and CI infrastructure. Complete native CI before its phase.
Reserve an operator-attended maintenance window; exact downtime cannot be bounded until cache counts/backup throughput
are known. Singleton applications can be unavailable during drain and recovery. Never proceed to a second node before
the first is accepted. Pause if either peer cannot maintain Kubernetes/etcd quorum.

1. Verify signed candidate/recovery digests and current inventory. Confirm no Omni operation is active, then lock
   `galactic` without changing desired Talos/Kubernetes versions. Save a peer etcd snapshot and private configuration/
   workload/storage evidence. Transfer etcd leadership away from the target if needed. Verify PVC backup/recovery
   availability using existing storage operations; do not read or change user-home contents.
2. Cordon and drain only the selected node. Any PDB bypass, emptyDir loss, VM termination or checkpoint interruption
   must be named in the approval. Do not blanket force drain. Wait for all Firecracker users and loop mounts to stop.
3. Stage the exact signed Talos 1.14 r6 installer with `talosctl upgrade --drain=false --no-reboot --wait`, using the
   verified target address and immutable candidate installer from the artifact gate. Require success before continuing.
4. Stop the target's CRI/containerd and kubelet writers through existing approved host maintenance access. Verify they
   remain stopped and that no relevant task, loop device, mount or open file references the blockfile cache. An access
   method that survives CRI being stopped must be reviewed before this phase; a Kubernetes Pod on that CRI is insufficient.
5. Back up the entire blockfile directory plus the matching CRI containerd metadata store and records to an off-node
   location, preserving sparse files, IDs, ownership, permissions and hardlinks. Verify manifest/checksums and prove a
   restoration on copies before modifying any original. Budget backup bytes from actual allocation, plus at worst
   512 MiB additional allocation for each scratch/snapshot file and room for the candidate image layers. Abort on a
   space shortfall, unexpected file size/type/link count, mounted file or fsck error.
6. Grow only the inventoried unmounted ext4 scratch and numeric snapshot files currently at 536870912 bytes:
   `e2fsck -f -n "$file"`, `truncate -s 1073741824 "$file"`, `resize2fs "$file"`, then `e2fsck -f -n "$file"`.
   Verify 262144 blocks of 4096 bytes and preserved UUID/ownership/modes/content. Leave already validated 1 GiB files
   alone. Do not format, shrink, delete, move, rename or hand-edit metadata. Old grown files can have 65536 inodes;
   the new empty template has 32768. Containerd's cached usage accounting is approximate; compare actual allocation
   during acceptance. Keep a per-file completion journal so any partial failure remains recoverable.
7. Perform one controlled reboot. Keep the node cordoned. Verify r6 and both bundled/persistent scratch geometry,
   all inventoried parent sizes, disks/identity/network, etcd, storage, GPU and all four Kata runtime canaries.
   A separately approved disposable non-user Firecracker canary must exercise cached-parent extraction of an image
   over 512 MiB, inspect its actual guest root capacity, and complete offline fresh-home/restart checks.
8. Verify workload and PVC recovery, then uncordon the target and finish its acceptance before moving on. Preserve
   the Omni lock until the direct replacements finish; unlock/converge under the existing runbook without changing
   OS/Kubernetes or application desired versions.
9. Only after all eligible hosts pass, coordinate PR14781's reviewed merge and ordinary Kargo promotion. Its exact
   published digest, offline clean/existing-home/restart tests and real cold-start critical path must be verified in a
   separately approved disposable test account/VM. Preparation does not authorize account/VM creation.

## Recovery and rollback

Stop at the first failing gate and leave the target cordoned. If any growth operation fails, keep writers stopped,
restore the **complete paired** cache/CRI metadata backup at the same paths, verify checksums/fsck, and restore the
old signed Talos 1.14 r5 installer using the existing recovery procedure. Never truncate a grown ext4 back to 512 MiB.
Do not mix metadata from one checkpoint with blockfiles from another. Original user homes/PVCs remain outside this
cache operation; loss of an unbacked ephemeral root or interrupted emptyDir workload is nevertheless a data risk.

The r5 template can also coexist with already-grown cached files if needed for recovery. Do not claim complete
rollback until a canary and workload recovery pass. Once the larger Nanoagent image is promoted, roll it back through
the existing Kargo path before restoring a 512 MiB cache. Retain off-node backups and original installer receipts until
post-rollout acceptance and a separately authorized retention cleanup.
