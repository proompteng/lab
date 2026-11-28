# Turin local NVMe storage

The Intel and Transcend mounts contain persistent workloads. Current policy reserves these
devices for explicit retained workloads; preserve their files and existing bound volumes.
Bayn's `data-ledger-0` already uses the Intel mount. Never clear, wipe, format, or recycle
either mount based on this document's historical scratch filename.

The [local-path application](../../../argocd/applications/local-path/README.md) owns allocation
policy, its [configuration](../../../argocd/applications/local-path/patches/local-path-config.patch.yaml)
owns the provisioner's paths, and the [Omni cluster template](../../galactic/omni/cluster-template.yaml)
owns Talos volume configuration. Kafka's static volumes are owned by the
[Kafka application](../../../argocd/applications/kafka/README.md). Preserve existing claim paths when
changing the allocation policy for future claims.

## Verified mount identities

Read-only Talos disk, volume, and mount inspection on 2026-11-18 confirmed:

| Volume                   | Stable disk selector                                         | Observed partition | Filesystem and mount                   |
| ------------------------ | ------------------------------------------------------------ | ------------------ | -------------------------------------- |
| `u-turin-nvme-intel`     | `/dev/disk/by-id/nvme-INTEL_SSDPEKKF256G8L_BTHH851313AU256B` | `/dev/nvme0n1p1`   | XFS at `/var/mnt/turin-nvme-intel`     |
| `u-turin-nvme-transcend` | `/dev/disk/by-id/nvme-TS256GMTE652T2_I203860329`             | `/dev/nvme1n1p1`   | XFS at `/var/mnt/turin-nvme-transcend` |

Both devices report 256 GB and both user volumes are Ready. NVMe enumeration can change
across boots; verify model, serial, stable selector, partition, and actual mount together.
The selectors must continue to use stable by-id symlinks. A historical `nvmeXn1` name or
an old partition-cleanup receipt does not authorize a disk operation.

The original manifest filenames,
[`local-path-scratch-intel.patch.yaml`](../manifests/local-path-scratch-intel.patch.yaml) and
[`local-path-scratch-transcend.patch.yaml`](../manifests/local-path-scratch-transcend.patch.yaml),
also retain historical names. Check the current Omni-owned configuration and the live mounts
before preparing any change.

## Allocation and ownership

| Purpose                               | Current Turin path              | Storage ownership                                                                                                    |
| ------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| New general `local-path` allocations  | `/var/local-path-provisioner`   | Local-path provisioner, on the large system NVMe                                                                     |
| New `local-path-ci-amd64` allocations | `/var/lib/kubelet/ci-amd64`     | CI scratch directory, on the same system filesystem                                                                  |
| Explicit retained Intel workloads     | `/var/mnt/turin-nvme-intel`     | Existing bound paths, including `bayn/data-ledger-0`; dedicated Bayn WAL allocation uses its `bayn-wal` subdirectory |
| Explicit retained Transcend workloads | `/var/mnt/turin-nvme-transcend` | Existing workload-owned paths and static volumes                                                                     |
| Retained `bayn/data-ledger-1`         | `/var/mnt/tigerbeetle`          | Static PV and Omni `UserVolumeConfig/tigerbeetle`, with `volumeType: directory`                                      |

The large system NVMe's persistent XFS `EPHEMERAL` volume is mounted at `/var`; its observed
partition was `/dev/nvme3n1p4`. General local-path, CI, and the TigerBeetle directory volume
share that physical device. Separate directories do not isolate I/O or host failure.

Local-path configuration reloads affect future allocation. They do not move existing files,
remount disks, or rewrite bound PV paths. A requested PVC size does not enforce a filesystem
quota, so check actual free space and existing workload use before allocating another claim.

## Read-only preflight

Use the current Omni node identity and inspect storage without changing it:

```bash
talosctl get disks --nodes 8bf7ec00-171c-11f1-8000-7cc255f16774
talosctl get volumestatus --nodes 8bf7ec00-171c-11f1-8000-7cc255f16774
talosctl get mountstatus --nodes 8bf7ec00-171c-11f1-8000-7cc255f16774
kubectl -n bayn get pvc data-ledger-0 data-ledger-1 data-ledger-2 -o wide
kubectl get pv <bound-pv-name> -o yaml
```

Before any separately reviewed storage change:

1. Match the disk model and serial to the stable selector and live mounted filesystem.
1. Inventory every affected bound PVC/PV, its UID, claimRef UID, source path, node affinity,
   reclaim policy, and owning workload.
1. Verify the actual helper or workload mount is on the intended filesystem. If a mount is
   missing, stop; a directory on the parent filesystem can otherwise hide that mistake.
1. Measure available space on the target filesystem and preserve all existing bound paths.
1. Use the owning workload's migration and recovery procedure. Disk readiness alone does
   not qualify a ledger copy, a database failover, or a cleanup.

## Retention and recovery

Persistent Talos mounts do not imply that every PV has a `Retain` reclaim policy.
The TigerBeetle cluster's `deletionPolicy: Retain` also does not establish the reclaim policy
of each bound PV. Inspect each PV separately before a lifecycle operation; a retained workload
must not lose its files through claim deletion or provisioner cleanup.

These local filesystems remain single-host storage. A Talos reset, filesystem loss, or device
replacement can destroy the local replica. Preserve healthy peers, backups, and the original
data until the owning workload's native protocol and financial checks accept recovery.

The [replica 1 handoff](../../galactic/scheduling/tigerbeetle-ledger1-handoff.md) has a fixed
retained target under `/var/mnt/tigerbeetle`. It preserves the existing ledger file, ordinal,
PVC UID, and PV name. Its procedure does not authorize reusing another replica's path or
clearing the Intel or Transcend mounts.
