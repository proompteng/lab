# Move TigerBeetle replica 1 from Ryzen to Turin

This is the bounded local-volume handoff for `bayn/ledger-1`. It preserves the existing ledger file, cluster ID,
replica ordinal, PVC UID, and PV name. Kubernetes 1.37 makes this PV's node affinity immutable, so its metadata must
be replaced after an offline copy. The PVC and source file must never be deleted. This procedure does not apply to
Ceph volumes, any other replica, or a lost TigerBeetle data file.

The target keeps replicas 0 and 1 on Turin and replica 2 on Altra. A Turin outage loses quorum. Three replicas across
two hosts do not provide tolerance of either host's failure.

## Fixed identities and admission

| Resource            | Required identity                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Context / namespace | `galactic-lan` / `bayn`                                                                       |
| Cluster ID          | `122731676035874920802382025803517750735`                                                     |
| Replica / PVC       | `ledger-1` / `data-ledger-1`                                                                  |
| PVC UID             | `d7517621-a1ed-4961-96d6-060d7ecb7f61`                                                        |
| PV name             | `pvc-d7517621-a1ed-4961-96d6-060d7ecb7f61`                                                    |
| Source hostname     | `talos-192-168-1-194`                                                                         |
| Target hostname     | `turin`                                                                                       |
| Ledger filename     | `122731676035874920802382025803517750735_1.tigerbeetle`                                       |
| Source directory    | `/var/mnt/local-path-provisioner/pvc-d7517621-a1ed-4961-96d6-060d7ecb7f61_bayn_data-ledger-1` |
| Target directory    | `/var/mnt/tigerbeetle/pvc-d7517621-a1ed-4961-96d6-060d7ecb7f61_bayn_data-ledger-1`            |

The target is a retained, static local PV under the Omni-owned `UserVolumeConfig/tigerbeetle` with
`volumeType: directory`. It uses Turin's 4.1 TB ORICO system disk, whose existing `EPHEMERAL` partition is persistent
XFS at `/var`. Talos exposes this directory volume writable to the kubelet without partitioning or formatting a disk.
It is outside both rebuildable scratch mounts and the provisioner's scratch-directory
allocation. Preserve it across normal Omni upgrades, and treat a Talos reset or system-disk replacement as a ledger
replica loss requiring healthy peers and the retained source copy. Never place a ledger on `turin-nvme-intel` or
`turin-nvme-transcend`; those disks remain scratch-only. Check the target helper's actual filesystem device and free
space against the live Talos `EPHEMERAL` volume before copying. The legacy `local-path` class name is preserved only
because the existing PVC's class is immutable; this procedure creates the retained PV explicitly.

Require three Ready hosts, healthy Ceph data/quorum, and working cross-host Services. Bayn must report EXACT
reconciliation, zero unresolved mutations, and continuing progress from its existing exclusive execution owner.
Preserve execution authority, credentials, kill switches, epoch, and existing controller identity.

Before rollout, record all three Pod identities, the bound PVC/PV identities, the PV's exact source path and node
affinity, and the image digest in private receipts. Require three Ready TigerBeetle replicas and successful native
protocol/data readback. Verify the reviewed placement source changes only placement; it retains the cluster ID,
three replicas, image, storage class, and minimum-two PDB.

A disposable live rehearsal on Kubernetes 1.37 verified that replacing a Retain PV under the same name and exact
claimRef UID rebinds the unchanged PVC and schedules its waiting consumer on the new host. The rehearsal used an
isolated empty path and claim; it did not modify any Bayn volume. Production still requires every guard below.

## Offline copy and metadata replacement

1. Render and validate the merged Omni template, require its no-reboot dry run to add only Turin's directory volume,
   and sync only the reviewed `36-8bf7ec00-171c-11f1-8000-7cc255f16774-tigerbeetle-storage` patch. Require
   `u-tigerbeetle` Ready and the target helper to report XFS on the live `EPHEMERAL` device with sufficient free space.
   Complete the [required-affinity transition](README.md#transition-existing-required-host-separation) while all three
   original hosts remain eligible. Require three healthy replicas and verify preferred separation on every actual
   Pod before applying the final two-host restriction. Preserve the cluster image, identities, claims, and PDB.
   Switch the Bayn PostgreSQL primary to the caught-up Turin instance through CNPG before applying its new host
   affinity. Deliver the reviewed placement through normal image publication, Kargo promotion, and Argo's generated
   revision. Require both PostgreSQL instances healthy on separate 100G hosts before continuing to TigerBeetle.
2. Let the TigerBeetle operator roll the placement template. Require replicas 0 and 2 Ready and replica 1 Pending
   because its retained PV still requires Ryzen while its new Pod requires a 100G host. Prove the original replica 1
   Pod UID and process are gone. Do not copy a live ledger or disrupt another replica during this interval.
3. Use two temporary, explicitly pinned copy Pods in `local-path-storage`, whose existing namespace policy permits
   the provisioner's host-path operations. Mount only the fixed source directory read-only on Ryzen and only the
   fixed target directory writable on Turin. Use the reviewed BusyBox image, no service-account token, dropped
   capabilities, a read-only container filesystem, bounded resources and lifetime, and the explicit Ryzen toleration.
   Server-dry-run the manifests first. Refuse an existing destination ledger or insufficient destination space.
4. Record the source file's size, mode, owner, and SHA-256. Stream only the named ledger through `tar` between those
   helpers with pipeline failure checking. Preserve ownership and permissions, flush the destination, then require
   identical size and SHA-256 on both hosts. Recheck the source checksum to prove it stayed stable while copied.
   No `format`, `recover`, empty-file substitute, or copy of a different ordinal is allowed.
5. Snapshot the original PV and PVC privately. Patch only the original PV's reclaim policy to `Retain`, with
   UID/resourceVersion and original-value preconditions. Read it back before deletion. Preserve the old Ryzen file
   for recovery even after acceptance.
6. Prepare a replacement PV with the same name, capacity, access/volume modes, storage class, and exact original
   claimRef including PVC UID. Its hostPath must be the fixed retained Turin directory and its required hostname Turin.
   Keep `Retain`. Remove server metadata from the creation document. Never clear or replace the PVC's volumeName.
7. Immediately recheck the two healthy peers, unchanged claim UID, offline original replica, Pending replacement,
   target file checksum, 100G node labels, and PV/PVC bindings. Delete only that PV metadata with UID/resourceVersion
   preconditions. While the unchanged PVC protects it, remove only `kubernetes.io/pv-protection`, guarded by the
   original PV UID, deletionTimestamp, Retain policy and exact expected finalizer list. Refuse unknown finalizers.
   Create the prepared same-name PV. Do not delete a PVC, provisioner directory, or VolumeAttachment.
8. Require the same PVC UID to become Bound to the same PV name with the new PV UID and Turin node affinity. If the
   binding fails, stop and recover this handoff before any other disruption. The copied destination file must exist
   before the replacement's format init runs; verify the init explicitly reused the existing file.

## Acceptance and recovery

Require all three replicas Ready, the operator's current-generation native Nop health check successful, and replica 1
running on Turin with the original ordinal and data file. Check the actual Pod hostnames for the two-plus-one layout.
Require Bayn EXACT reconciliation, zero discrepancies/unresolved mutations, unchanged execution epoch and authority,
and a fresh natural controller completion after recovery. Preserve both PostgreSQL PVCs and synchronous replication.

Remove only the two owned helper Pods after these checks. Retain the original source file and private metadata/checksum
receipts. Pod readiness or a merged placement PR alone does not establish a completed migration.

If failure occurs before PV replacement, retain the source and copied file and repair the failed copy or precondition.
If failure occurs after replacement, preserve both files and the unchanged PVC. Restore only the captured PV metadata
under its verified identity and Retain policy; never let both replica 1 processes start. Returning the replica to
Ryzen also requires a reviewed placement recovery because its current 100G selector excludes Ryzen. Keep the two
healthy peers available, do not format a replacement file, and do not proceed to another stateful move until the
same replica and Bayn data readback recover.
