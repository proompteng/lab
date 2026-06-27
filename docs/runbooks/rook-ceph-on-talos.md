# Rook-Ceph on Talos (galactic) Runbook

This runbook documents the current Rook-Ceph configuration for the Talos-based `galactic` cluster.

Current Kubernetes and Talos access endpoints are tracked in
`docs/runbooks/galactic-kubernetes-access.md`. The Kubernetes node names below
still contain old `192.168.1.*` addresses, but the current LAN reachability path
uses the provider-managed `100.100.244.*` segment.

## Safety

Ceph will **wipe** any disks listed under `cephClusterSpec.storage.nodes[].devices`.

Do not include Talos install disks in the device list.

## Cluster nodes (Talos)

Control plane nodes:

1. `talos-192-168-1-85` (altra)
1. `talos-192-168-1-194` (ryzen)
1. `turin`

Storage OSD nodes in this configuration:

1. `talos-192-168-1-85`
1. `turin`

Monitor placement:

1. `talos-192-168-1-194` is included in MON placement and intentionally not assigned OSDs.

## Disks used for OSDs

`talos-192-168-1-85`:

1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA12R7C` (HDD)
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LKW9` (HDD)
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0HS7E` (HDD)

The 4TB NVMe (`nvme-CT4000P3PSSD8_2402E88D0863`, `/dev/nvme1n1`) is the BlueStore DB/WAL metadata device for the three HDD OSDs on this host.

Talos install disk on `talos-192-168-1-85`:

1. `/dev/nvme0n1` (do not use for Ceph)

`turin`:

1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0NL5D` (HDD)
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0MZ1M` (HDD)
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LVM9` (HDD)

The 1TB Kingston NVMe (`nvme-KINGSTON_SNV3S1000G_50026B76878F0B27`, `/dev/nvme2n1`) is the BlueStore DB/WAL metadata device for Turin's three HDD OSDs.

Talos install and local-only disks on `turin`:

1. `/dev/nvme3n1` (Talos install / EPHEMERAL; do not use for Ceph)
1. `/dev/nvme0n1` and `/dev/nvme1n1` (single-host NVMe; only use for rebuildable local scratch/cache after explicit Talos local storage configuration)

Do not place replicated Ceph data, databases, registry canonical storage, Kafka data, or Torghut durable state on the single-host 256GB Turin NVMes. They are acceptable only for rebuildable scratch such as CI work directories, model caches, and temporary download paths pinned to Turin.

## Replication settings (2 storage hosts)

Because OSDs are only on 2 hosts, any pools with `failureDomain: host` must use replicated size `2` (not `3`).

Current values live in:

1. `argocd/applications/rook-ceph/cluster-values.yaml`

## GitOps locations

Rook-Ceph app:

1. `argocd/applications/rook-ceph`

ApplicationSet placement:

1. `argocd/applicationsets/bootstrap.yaml` (contains the `rook-ceph` app entry)

Rook operator and cluster chart versions:

1. `argocd/applications/rook-ceph/kustomization.yaml`

RWX performance workflow:

1. `docs/runbooks/rook-ceph-rwx-performance.md`

## Install / rollout steps

1. Ensure you have verified the disk inventory on each node (example):

```bash
talosctl -n 192.168.1.85 get disks -o yaml
talosctl -n 192.168.1.203 get disks -o yaml
```

1. Enable `rook-ceph` in `argocd/applicationsets/bootstrap.yaml`.

1. Sync:

```bash
argocd app sync root
argocd app sync rook-ceph
```

1. Verify:

```bash
kubectl -n rook-ceph get pods
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph mgr module ls
```

The cluster enables the Ceph mgr `stats` module declaratively so `ceph fs perf stats` is available during RWX investigations.

## Turin BlueStore DB/WAL migration

Use this procedure when Turin OSDs are healthy but still run as single-device HDD BlueStore OSDs with no active `block.db`.

Rook applies `metadataDevice` only when an OSD is prepared. It does not retrofit an existing OSD onto a new DB/WAL device. The safe path is therefore a one-OSD-at-a-time remove, purge, targeted zap, and reprepare cycle after the GitOps spec has the desired `metadataDevice`.

Do not migrate all three Turin OSDs at once. Do not wipe the whole Kingston NVMe. Do not run the historical three-OSD recreate flow unless the cluster is already degraded and the old OSD IDs are intentionally abandoned.

Target mapping for the current Turin migration:

| OSD | HDD by-id | active block device | stale/suspect DB LV observed on `/dev/nvme2n1` |
| --- | --- | --- | --- |
| `osd.0` | `ata-ST24000NM000C-3WD103_ZXA0LVM9` | `/dev/sdd` | `osd-db-bee41e04-e080-423b-a493-894495af0579` |
| `osd.1` | `ata-ST24000NM000C-3WD103_ZXA0MZ1M` | `/dev/sdb` | `osd-db-c515cd50-a905-42bf-bfd2-c4a2125af075` |
| `osd.2` | `ata-ST24000NM000C-3WD103_ZXA0NL5D` | `/dev/sdc` | `osd-db-98938ffa-1017-4e8d-9ad6-c2f7fe4ce2d5` |

Preflight before each OSD:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg stat
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf
```

Required shape before continuing:

1. `HEALTH_OK`.
1. All PGs are `active+clean`.
1. No `recovery`, `backfill`, `remapped`, `misplaced`, `degraded`, or `undersized` PGs.
1. Argo CD has applied the Rook values containing Turin `metadataDevice`, OSD memory target, and CSI read affinity.
1. The previous OSD migration, if any, already proves `block.db` is active.

Cycle exactly one OSD:

1. Mark the OSD out and wait for `active+clean`:

   ```bash
   OSD_ID=0
   kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd out "osd.${OSD_ID}"
   watch -n 30 'kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s'
   ```

1. Confirm Ceph says it is safe to destroy:

   ```bash
   kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd safe-to-destroy "osd.${OSD_ID}"
   ```

1. Stop the OSD deployment and purge the Ceph identity:

   ```bash
   kubectl -n rook-ceph scale deploy "rook-ceph-osd-${OSD_ID}" --replicas=0
   kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge "${OSD_ID}" --yes-i-really-mean-it
   ```

1. Use a temporary privileged Ceph pod pinned to Turin to zap only the matching HDD OSD block LV and the matching stale DB LV, if still present. Confirm with `ceph-volume lvm list --format json` before every zap.

1. Delete the temporary zap pod, restart or rerun the Turin OSD prepare job, and let Rook reprepare the same HDD with `metadataDevice: /dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B76878F0B27`.

1. Verify the replacement OSD before moving to the next ID:

   ```bash
   NEW_OSD_ID=<new-or-reused-id>
   kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata "${NEW_OSD_ID}" --format json-pretty
   OSD_POD="$(
     kubectl -n rook-ceph get pod \
       -l "app=rook-ceph-osd,ceph-osd-id=${NEW_OSD_ID}" \
       -o jsonpath='{.items[0].metadata.name}'
   )"
   kubectl -n rook-ceph exec "$OSD_POD" -- sh -lc 'ls -l /var/lib/ceph/osd/ceph-*/block*'
   kubectl -n rook-ceph exec "$OSD_POD" -- ceph daemon "osd.${NEW_OSD_ID}" config get bluefs_dedicated_db
   kubectl -n rook-ceph exec "$OSD_POD" -- ceph daemon "osd.${NEW_OSD_ID}" config get bluefs_single_shared_device
   ```

Acceptance for each replacement:

1. The OSD is `up` and `in` under host `turin`.
1. `block.db` exists in the OSD data directory.
1. `bluefs_dedicated_db=1`.
1. `bluefs_single_shared_device=0`.
1. The cluster returns to `HEALTH_OK` and all PGs are `active+clean`.

## Recovery: Talos node host jump (same disks, new hostname/IP)

Use this when the same hardware returns with a different Talos node name (example: `talos-192-168-1-202` -> `talos-192-168-1-203`) and Ceph shows the old host down.

Typical symptoms:

1. `ceph health detail` shows `1 host (N osds) down`, inactive/undersized PGs, or degraded data availability.
1. `ceph osd tree` still contains the old host name with down OSDs.
1. `kubectl get nodes` shows the replacement host (`...-203`) instead of the previous name (`...-202`).

Recovery flow:

1. Commit GitOps host updates first:

```bash
# Update the following file in Git:
# argocd/applications/rook-ceph/cluster-values.yaml
# - cephClusterSpec.placement.mon.nodeAffinity values
# - cephClusterSpec.storage.nodes[].name
argocd app sync rook-ceph
```

1. If OSD deployments for the new host do not appear, trigger an OSD prepare job for the new hostname with both env vars set correctly:

```bash
# Example from this incident
kubectl -n rook-ceph create job --from=job/rook-ceph-osd-prepare-talos-192-168-1-85 rook-ceph-osd-prepare-talos-192-168-1-203
kubectl -n rook-ceph set env job/rook-ceph-osd-prepare-talos-192-168-1-203 ROOK_NODE_NAME=talos-192-168-1-203 ROOK_CRUSHMAP_HOSTNAME=talos-192-168-1-203
kubectl -n rook-ceph delete pod -l job-name=rook-ceph-osd-prepare-talos-192-168-1-203
kubectl -n rook-ceph logs -f job/rook-ceph-osd-prepare-talos-192-168-1-203
```

1. Remove stale CRUSH host entry after new OSDs are up:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush rm talos-192-168-1-202
```

1. Validate end state:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd stat
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

## Recovery: HEALTH_ERR due to stale CephFS (`ceph-filesystem`) and `size=3` pools

This incident happened when a stale `CephFilesystem` (`ceph-filesystem`) existed in-cluster but was no longer managed in Git.
It left a CephFS filesystem with a failed MDS, which keeps Ceph in `HEALTH_ERR`.

Typical symptoms:

1. `kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail` reports `FS_DEGRADED`, `FS_WITH_FAILED_MDS`, and/or `MDS_ALL_DOWN` for `ceph-filesystem`.
1. `kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph fs ls` shows both `cephfs` and `ceph-filesystem`.
1. `ceph health detail` shows `active+undersized+degraded` PGs because some pools are still `size 3` (common: `.mgr` and `default.rgw.*`) while this cluster only has 2 OSD hosts.

Recovery flow:

1. Prune any stale Rook resources that are no longer in Git:

```bash
argocd app sync rook-ceph --prune
```

1. If `ceph fs ls` still shows `ceph-filesystem`, confirm there are no clients and the filesystem is unhealthy:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph fs status ceph-filesystem
```

1. Remove the stale filesystem from Ceph (destructive):

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph fs rm ceph-filesystem --yes-i-really-mean-it
```

1. If the Kubernetes CRs get stuck terminating, clear finalizers (emergency only):

```bash
kubectl -n rook-ceph patch cephfilesystemsubvolumegroup ceph-filesystem-csi --type=merge -p '{"metadata":{"finalizers":[]}}'
kubectl -n rook-ceph patch cephfilesystem ceph-filesystem --type=merge -p '{"metadata":{"finalizers":[]}}'
```

1. If `ceph health detail` still shows `PG_DEGRADED`, check for pools that are still `size 3`:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool ls detail | rg "size 3"
```

1. For a 2-host OSD cluster, shrink the affected pools to size 2 (emergency fix):

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set .mgr size 2
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set .mgr min_size 1

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set default.rgw.log size 2
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set default.rgw.log min_size 1

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set default.rgw.control size 2
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set default.rgw.control min_size 1

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set default.rgw.meta size 2
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set default.rgw.meta min_size 1
```

1. Make the fix reproducible (prevention): in `argocd/applications/rook-ceph/cluster-values.yaml`, set `cephClusterSpec.cephConfig.global.osd_pool_default_size: "2"` and `cephClusterSpec.cephConfig.global.osd_pool_default_min_size: "1"` for this 2-host OSD cluster.
1. Validate end state:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

## Recovery: `MON_DISK_LOW` on a monitor node

This is the recovery runbook for monitor available-space warnings such as:

```text
HEALTH_WARN mon x is low on available space
```

1. Confirm the warning and current monitor warning thresholds:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail | rg "MON_DISK_LOW|mon .*low on available space"
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config get mon mon_data_avail_warn
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config get mon mon_data_avail_crit
```

1. Identify which monitor is low and check host usage for monitor paths:

```bash
MON_ID=f  # e.g. a, e, or f
MON_POD="$(kubectl -n rook-ceph get pods -l app=rook-ceph-mon -o jsonpath='{range .items[*]}{.metadata.name} {.metadata.labels.ceph_daemon} {.metadata.labels.ceph_daemon_id}{\"\\n\"}{end}' | awk -v mon=\"${MON_ID}\" '$2==\"mon\" && $3==mon {print $1}' | head -n1)"
kubectl -n rook-ceph exec "$MON_POD" -- sh -lc 'df -h / /run/ceph /var/lib/ceph /var/log/ceph'
kubectl -n rook-ceph exec "$MON_POD" -- sh -lc "du -h /var/lib/ceph/mon/ceph-${MON_ID} | sort -rh | head -n 50"
```

1. Run low-impact monitor cleanup steps:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph crash stat
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph crash archive all
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph tell mon.${MON_ID} compact
```

1. Recheck health and disk status:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail | rg "MON_DISK_LOW|HEALTH_"
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec "$MON_POD" -- df -h /run/ceph
```

If usage remains near-warning after compaction, inspect node-level pressure and clean obvious node/system log buildup outside Ceph before moving monitor storage.
