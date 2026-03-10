# Rook-Ceph BlueStore Metadata Migration on Talos

This runbook migrates the two Talos OSD hosts from HDD-only OSD layout to HDD data devices with host-local NVMe
BlueStore metadata devices.

## Target layout

`talos-192-168-1-85`:

1. HDD OSD data devices:
   1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA12R7C`
   1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LKW9`
   1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0HS7E`
1. BlueStore metadata device:
   1. `/dev/disk/by-id/nvme-CT4000P3PSSD8_2402E88D0863` (`/dev/nvme1n1`)

`talos-192-168-1-203`:

1. HDD OSD data devices:
   1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0NL5D`
   1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0MZ1M`
   1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LVM9`
1. BlueStore metadata device:
   1. `/dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B76878F0B27` (`/dev/nvme2n1`)

## Why OSDs must be recreated

Existing OSDs were provisioned without `metadataDevice`. Adding `metadataDevice` later changes how newly prepared
OSDs place BlueStore DB/WAL, but it does not retroactively migrate existing OSD layouts. In this host-based Rook
cluster, the safe path is to update GitOps first and then recreate OSDs one at a time.

## Preconditions

1. `talos-192-168-1-203` is uncordoned and Ceph is healthy enough to continue.
1. `ceph -s` shows all OSDs `up/in` before starting destructive work.
1. `85` spare NVMe is no longer needed for `local-path`.
1. No active PVs reference `/var/mnt/local-path-provisioner-extra`.

## 203 post-bifurcation inventory

`talos-192-168-1-203` should show:

1. `nvme0n1` `ORICO` as the Talos system disk
1. `nvme1n1` `TS256GMTE652T2` as a partitioned 256 GB device
1. `nvme2n1` `KINGSTON SNV3S1000G` as the raw 1 TB Ceph metadata candidate

The PCIe slot was configured in BIOS with `PCIE5 Link Width = x4x4x4x4` so the passive RIITOP NVMe carrier
enumerates all installed drives.

## 85 reclaim sequence

1. Remove `/var/mnt/local-path-provisioner-extra` from the local-path ConfigMap in Git.
1. Remove the historical `local-path-provisioner-extra` Talos patch from the repo.
1. Cordon and drain `talos-192-168-1-85`.
   `85` currently runs singleton and PDB-protected workloads, so maintenance may require a disruptive drain path that
   bypasses PDBs and restarts those services.
1. Set `ceph osd set noout` before reboot or disk mutation.
1. Apply an updated Talos machine config on `85` that removes the `UserVolumeConfig` named
   `local-path-provisioner-extra`.
1. Reboot `85`.
1. Verify `u-local-path-provisioner-extra` is gone from `talosctl get volumestatus`.
1. Wipe `/dev/nvme1n1`.

## Rook rollout sequence

1. Update `argocd/applications/rook-ceph/cluster-values.yaml` with node-level `metadataDevice` for `85` and `203`.
1. Do not set `databaseSizeMB` when the intention is to let BlueStore consume the full metadata NVMe.
1. Sync `rook-ceph`.
1. Recreate OSDs one at a time:
   1. `203` OSDs first
   1. `85` OSDs after `nvme1n1` reclaim is complete
1. Wait for `active+clean` between each OSD replacement.

## Validation

After each OSD recreation:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph get pods -o wide | rg 'rook-ceph-osd'
```

Before benchmarking:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph mds stat
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph fs perf stats
```

Benchmark again with:

1. [rook-ceph-rwx-performance.md](/Users/gregkonush/.codex/worktrees/5adc/lab/docs/runbooks/rook-ceph-rwx-performance.md)

## Executed 2026-03-10

This migration was executed live on 2026-03-10.

### Live disk outcomes

`talos-192-168-1-85`:

1. `nvme1n1` was removed from `local-path-provisioner-extra`.
1. `/dev/nvme1n1p1` was wiped.
1. Rook recreated `osd.3`, `osd.4`, and `osd.5` with dedicated BlueStore DB on `nvme1n1`.

`talos-192-168-1-203`:

1. BIOS was updated to `PCIE5 Link Width = x4x4x4x4` so the passive RIITOP carrier enumerated all NVMe devices.
1. `nvme2n1` (`KINGSTON_SNV3S1000G_50026B76878F0B27`) was selected as the Ceph metadata device.
1. `osd.0`, `osd.1`, and `osd.2` were recreated against the existing HDDs with BlueStore DB on `nvme2n1`.

### Verification commands

Verify BlueStore DB placement:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 0
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 1
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 2
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 3
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 4
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 5
```

Expected results from this migration:

1. `osd.0`, `osd.1`, `osd.2`
   1. `bluefs_dedicated_db: 1`
   1. `bluefs_db_devices: nvme2n1`
2. `osd.3`, `osd.4`, `osd.5`
   1. `bluefs_dedicated_db: 1`
   1. `bluefs_db_devices: nvme1n1`

### Recovery procedure used after OSD recreation

The recreated `203` OSDs initially returned with PGs stuck `incomplete` because Ceph was blocked on PG history from the
old shards. Restarting OSDs did not permanently clear the state.

The successful recovery sequence was:

1. Keep `ceph osd set noout` in place.
1. Mark `osd.0`, `osd.1`, and `osd.2` `out`.
1. Scale `rook-ceph-osd-0`, `rook-ceph-osd-1`, and `rook-ceph-osd-2` to `0` so Ceph stops trying to peer against the
   newly recreated `203` shards.
1. Repair the surviving authoritative shards on `85` one OSD at a time with `ceph-objectstore-tool --op mark-complete`.
1. Scale `rook-ceph-osd-0`, `rook-ceph-osd-1`, and `rook-ceph-osd-2` back to `1`.
1. Mark `osd.0`, `osd.1`, and `osd.2` back `in`.
1. Clear the final single-object `recovery_unfound` state with `ceph pg 12.41 mark_unfound_lost revert`.
1. `ceph osd unset noout`.

Helper-pod pattern used on `85` while the target OSD deployment was scaled to `0`:

```bash
ceph-objectstore-tool --no-mon-config --data-path /var/lib/ceph/osd/ceph-<id> --op info --pgid <pgid>
ceph-objectstore-tool --no-mon-config --data-path /var/lib/ceph/osd/ceph-<id> --op mark-complete --pgid <pgid>
```

Host-backed OSD data paths used during the repair:

1. `osd.3`: `/var/lib/rook/rook-ceph/5ade350d-92fe-49df-829e-37c1fbaf6c50_d30c19c2-9e14-46d2-8bd4-928b53f814f5`
1. `osd.4`: `/var/lib/rook/rook-ceph/5ade350d-92fe-49df-829e-37c1fbaf6c50_ea521431-8cf7-4195-98c5-e88590f6b9b2`
1. `osd.5`: `/var/lib/rook/rook-ceph/5ade350d-92fe-49df-829e-37c1fbaf6c50_a14615e0-2889-4afc-be8c-f569cd57a0fd`

### Data-loss note

This recovery required one explicit lost-object decision:

1. `pg 12.41` in `objectstore.rgw.buckets.data`
1. exactly `1` unfound object
1. resolved with:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg 12.41 mark_unfound_lost revert
```

Treat this as a real object loss / rollback event for RGW data. Record it in incident notes if user-facing bucket data
must be audited after the migration.

### Temporary recovery tuning used during final backfill

Once all OSDs were back `up/in`, the last remapped PGs were still recovering very slowly because the cluster had
returned to effectively default mclock recovery limits.

Temporary override used to finish the migration:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_mclock_override_recovery_settings true
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_max_backfills 8
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_recovery_max_active_hdd 10
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_recovery_op_priority 5
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_recovery_sleep_hdd 0
```

Important note:

1. `osd_max_backfills` and `osd_recovery_max_active_hdd` only took effect after setting
   `osd_mclock_override_recovery_settings true`.
1. Revert these values after the cluster returns to `409 active+clean`:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_max_backfills 1
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_recovery_max_active_hdd 3
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_recovery_op_priority 3
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_recovery_sleep_hdd 0.1
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_mclock_override_recovery_settings false
```

### Final steady-state validation

Final cluster state after cleanup:

1. `ceph -s` returned `HEALTH_OK`
1. `6/6` OSDs `up/in`
1. `409 active+clean`
1. temporary helper pods `osd3-helper`, `osd4-helper`, and `osd5-helper` were deleted
1. historical crash records were archived with `ceph crash archive-all`

### Post-migration incident boundary

The BlueStore migration itself completed successfully, but a separate RBD incident was discovered afterward in
`replicapool`.

That incident is documented separately in:

1. [rook-ceph-rbd-metadata-incident-2026-03-10.md](/Users/gregkonush/.codex/worktrees/5adc/lab/docs/runbooks/rook-ceph-rbd-metadata-incident-2026-03-10.md)

Do not treat the RBD image-loss investigation as proof that the Talos host migration failed. The cluster-level
BlueStore migration ended in `HEALTH_OK` with all OSDs `up/in`.

### Post-migration RWX benchmark

With the cluster back at `HEALTH_OK`, the `rook-cephfs-fuse` benchmark was rerun using
[rook-ceph-rwx-performance.md](/Users/gregkonush/.codex/worktrees/5adc/lab/docs/runbooks/rook-ceph-rwx-performance.md).

Observed single-run results after the BlueStore metadata migration:

1. sequential write: `28274 KiB/s` (`~27.6 MiB/s`)
1. sequential read: `99655 KiB/s` (`~97.3 MiB/s`)
1. mixed `4k` randrw read: `928 KiB/s`
1. mixed `4k` randrw write: `408 KiB/s`
1. metadata create: `768 ops/s`
1. metadata stat: `5008 ops/s`
1. metadata delete: `1048 ops/s`

Use the RWX runbook for the comparative baseline table and interpretation.

## Rollback boundary

Rollback is only safe before an individual OSD is destroyed and recreated. Once an OSD replacement begins, complete
that OSD and return the cluster to `active+clean` before changing direction.
