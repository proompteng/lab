# Ryzen fresh-chain Firecracker canary

This replaces the previous mass-cache migration proposal. Do not execute the earlier whole-cache backup/growth
steps. No host maintenance or canary is authorized by this preparation.

## Boundary and prerequisites

Nanoagent PR14781 packages the tested compressed tools in a single filesystem layer starting from scratch.
Containerd 2.3.4 applies the first OCI layer with an empty parent and copies the persistent scratch. Its existing
512 MiB parent chains remain usable and are not selected for this new first layer. Later snapshots copy their own
parent, so old and new root sizes can coexist in the same snapshotter.

Keep the existing root_path, snapshot metadata, numeric parent files and user-home PVCs intact. Do not rename,
purge, grow or reinitialize existing snapshots, restore old metadata over normal containerd updates, or introduce
a second snapshotter/cache directory. Unreferenced images/snapshots may retire through ordinary GC; no expiry time
or forced cleanup is promised.

The first canary targets only Ryzen: Kubernetes node talos-192-168-1-194, Talos address 100.100.244.141, AMD64.
Turin and Altra are outside this approval. No existing VM is stopped, reset or used as a test identity.

The current runtime has recreate_scratch=false and therefore retains a grown persistent scratch even with its
installed r5 template. The smallest canary changes only that persistent scratch, not the Talos installer/template.
PR14782's signed r6 extension remains preparation for a separately approved durable template rollout; it is not
a prerequisite for this scratch-only experiment. Do not change OS/Kubernetes versions, runtime handlers, security,
networking, identity, memory or PVC defaults.

Required before execution:

- Exact-head native image checks and one-layer/configuration/metadata checks pass on AMD64 and ARM64.
- The AMD64 review artifact's SHA256SUMS, source_head, build_revision, image ID and sole first diff ID are verified.
  PR CI retains the tested Docker archive and receipt; these are unsigned review artifacts, not deployment receipts.
- An operator supplies reviewed access that survives Ryzen CRI/containerd shutdown, the existing Talos credentials,
  an off-node scratch-backup destination and recovery access. Agents Shell and CSI Pods on the paused CRI are
  insufficient. These access/backup inputs are currently missing.
- Refresh node, workload, PDB, Ceph and Firecracker inventory. In the 2026-10-06 04:08 UTC metadata inventory,
  Ryzen had 73 Running Pods, no running Firecracker Pod, and zero-disruption PDBs hermes/hermes and restate/restate.
  Its drain affects Hermes, Restate member 2, Bayn ledger/database replica, Kafka brokers, Temporal replicas,
  Ceph monitor/MDS and Argo controllers. Inspect the current selectors/volumes and name any permitted interruption.
  The earlier Ceph HEALTH_WARN must be classified by the storage operator; do not assume safe recovery.
- Confirm both peer nodes maintain etcd/storage availability and no Omni operation is active. Save normal peer
  etcd/recovery evidence. Do not read user-home contents. Exact downtime is not yet bounded; reserve an attended
  window for the writer pause and workload recovery.

## Proposed single-host experiment — explicit approval required

1. Publish only the verified AMD64 PR archive to the existing nanoagent repository under
   canary-tengri-chain-<source-head>-amd64. Record its immutable manifest digest and verify the pulled config/first
   diff ID against the receipt. This preparation tag is excluded by the existing Kargo ^kargo-sha-[0-9a-f]{40}$
   selection. Do not merge PR14781, publish a Kargo alias, or change the normal Tengri image.
2. Cordon and drain only talos-192-168-1-194 under its existing maintenance procedure. Respect PDBs; any exceptions
   for hermes/hermes or restate/restate, emptyDir loss, checkpoint interruption or singleton downtime require named
   approval. No blanket force drain or existing VM termination. Abort if any Firecracker VM is active.
3. Pause Ryzen kubelet/CRI writers through the reviewed maintenance channel. Verify scratch is not open for copying
   and no relevant pull/unpack is active. Leave existing snapshots/metadata in place. Capture their IDs, sizes,
   ownership/modes and filesystem UUIDs as evidence, plus normal namespace/snapshot records.
4. Back up only /var/lib/containerd/io.containerd.snapshotter.v1.blockfile/scratch off-node, preserving its mode,
   ownership and sparse layout. Record checksum, UUID, 512 MiB size and ext4 geometry; verify the copy and restoration
   on a disposable copy. Allow at least 512 MiB for this backup, at worst another 512 MiB for scratch growth, plus
   candidate image content, new snapshots and the disposable home PVC. Do not allocate the former 31 GiB parent
   growth budget or copy the 61 old parent files: none is modified.
5. With writers stopped, grow only that scratch: e2fsck -f -n, truncate -s 1073741824, resize2fs, then e2fsck -f -n.
   Require 262144 blocks of 4096 bytes, clean ext4, preserved UUID/owner/mode and unchanged existing parent files.
   Native scratch tests already cover growth and backup restoration. Do not format or shrink any filesystem.
6. Resume the existing writers, keep Ryzen cordoned, and verify its current runtime, peers, storage and workload
   recovery. No installer replacement or reboot is part of this first approval. Stop on a failed gate.
7. Create one node-pinned disposable test Pod in kata, using the current Tengri kata-fc guest configuration and
   the immutable candidate image, with one new labeled 16 GiB Block home PVC mounted by the existing home annotations.
   Names: tengri-chain-<source-head-prefix> and tengri-chain-<source-head-prefix>-home. Override only the test command
   to keep the guest available for its test driver; do not create a real account or MicroVM business resource.
   Verify the actual guest root is 1 GiB and the first cached layer has the receipt's diff ID and no parent.
   Execute the checked-in fresh-home test as UID1000 in an isolated guest network namespace using existing guest
   administrator capabilities; do not apply network policy or change node/guest security configuration.
   Record fresh/retained helper durations and fixture hashes. Recreate this owned Pod once with the same test PVC,
   validate all five helpers and retained fixtures, and verify old 512 MiB chains still have their original IDs/sizes.
8. Export receipts and results, delete only this run's Pod and newly created test PVC, recover the named workloads,
   then uncordon Ryzen. Retain the scratch backup pending separately approved cleanup. Stop after this canary.
   No Turin/Altra operation, cluster migration or global promotion follows automatically.

## Failure and rollback

Abort for unhealthy peers/storage, an active user VM, missing approved access, inadequate space, unexpected scratch
size/type/link count/mount, failed backup proof/fsck, or failed runtime/canary/workload recovery. Keep the node cordoned
and stop progression. While writers are paused, restore the saved scratch file at the same path if required; never
truncate a grown ext4 back to 512 MiB. Withdraw/clean only owned canary resources. Leave existing snapshots and both
snapshotter/CRI metadata stores intact; new 1 GiB parents can coexist with the old runtime. No complete-cache restore
or factory/installer rollback is part of this experiment.

Normal Tengri scheduling currently lacks a root-capacity selector. One successful pinned canary therefore does not
authorize global promotion. Any later durable template installation or additional host requires separate review
and approval. The larger image remains out of ordinary Kargo discovery until eligible scheduling targets are ready.
