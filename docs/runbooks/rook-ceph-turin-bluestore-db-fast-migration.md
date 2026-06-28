# Turin BlueStore DB Fast Migration Runbook

This runbook documents the fast path for moving Turin HDD OSD BlueStore
metadata onto the Kingston NVMe without purging and recreating the whole OSD.

The goal is to migrate only BlueFS/RocksDB metadata to `block.db`. Object data
stays on the existing HDD `block` device. That makes each OSD operation a short
maintenance stop instead of a 22-24 TiB replica rebuild.

## Documentation Basis

Use these upstream docs as the source of truth for the procedure:

1. Ceph `ceph-bluestore-tool` man page. This is the low-level tool for
   BlueStore operations including `bluefs-bdev-new-db`,
   `bluefs-bdev-migrate`, `bluefs-bdev-sizes`, `fsck`, and label inspection.
   <https://docs.ceph.com/en/latest/man/8/ceph-bluestore-tool/>
1. Ceph `ceph-volume lvm migrate` docs. These document the supported BlueFS
   data movement model for LVM-managed OSDs: move BlueFS data from `data`,
   `db`, or `wal` source devices to a target LV. The current Turin OSDs are raw
   OSDs, so the direct `ceph-bluestore-tool` path is used instead, but the
   migration model is the same.
   <https://docs.ceph.com/en/latest/ceph-volume/lvm/migrate/>
1. Ceph `ceph-volume lvm new-db` docs. These document attaching a DB LV and
   then using `bluefs-bdev-migrate` to move spilled BlueFS data to the DB
   device.
   <https://docs.ceph.com/en/reef/ceph-volume/lvm/newdb/>
1. Rook `CephCluster` CRD docs. These document storage device selection and
   metadata device configuration in the cluster CR.
   <https://rook.io/docs/rook/latest-release/CRDs/Cluster/ceph-cluster-crd/>
1. Argo CD skip-reconcile docs. Use this annotation to pause Application
   reconciliation during manual maintenance.
   <https://argo-cd.readthedocs.io/en/latest/user-guide/skip_reconcile/>
1. Ceph mClock config docs. Built-in profiles can override low-level
   reservation values; use `custom` when an exact recovery/client reservation
   split is required.
   <https://docs.ceph.com/en/latest/rados/configuration/mclock-config-ref/>

## Current Live Topology

As of the Turin migration window:

| OSD | HDD by-id | active block device | DB state |
| --- | --- | --- | --- |
| `osd.0` | `ata-ST24000NM000C-3WD103_ZXA0LVM9` | `/dev/sdd` | HDD-only, `bluefs_single_shared_device=1` |
| `osd.1` | `ata-ST24000NM000C-3WD103_ZXA0MZ1M` | `/dev/sdb` | HDD-only, `bluefs_single_shared_device=1` |
| `osd.2` | `ata-ST24000NM000C-3WD103_ZXA0NL5D` | `/dev/sdc` | complete, DB on Kingston `nvme2n1` |

Kingston NVMe state after `osd.2` was migrated:

```text
VG ceph-10525ca6-66f7-48fd-a13a-7f7063dcc31b
size 931.51 GiB
free 638.54 GiB
existing LV osd-db-3b8319fe-5339-4107-af9c-541e329179aa 292.97 GiB
```

Two additional `300000M` DB LVs fit on this device:

1. `osd-db-osd0`
1. `osd-db-osd1`

Recheck the VG and free space before creating LVs. Do not assume these values
are still current.

## Why This Is Faster

The slower fallback is:

1. Mark OSD out.
1. Wait for the cluster to move object replicas away from that OSD.
1. Purge and zap.
1. Reprepare the OSD.
1. Backfill/rebalance data again.

That path moves whole OSD object data and can take hours per OSD on 22-24 TiB
HDDs.

The fast path is:

1. Wait for the cluster to be clean.
1. Stop exactly one OSD.
1. Attach a DB LV to the existing BlueStore data directory.
1. Migrate BlueFS/RocksDB data from HDD `block` to NVMe `block.db`.
1. Start the same OSD ID again.

Only metadata is moved. Object data remains in place on the HDD.

## Hard Gates

Do not start an OSD DB migration unless these are true:

1. `6 osds: 6 up, 6 in`.
1. All PGs are `active+clean`.
1. `0` misplaced objects.
1. No `recovery`, `backfill`, `remapped`, `degraded`, `undersized`,
   `peering`, `stale`, `inactive`, or `incomplete` PGs.
1. `ceph osd ok-to-stop osd.N` succeeds for the target OSD.
1. The previous OSD migration, if any, already proves
   `bluefs_dedicated_db=1` and `bluefs_single_shared_device=0`.

The cluster may still have temporary operator-controlled warnings such as
`noout`, `noscrub`, or `nodeep-scrub`. Record them explicitly. They do not
replace the PG cleanliness gate.

## Preflight Commands

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg stat
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd ok-to-stop osd.0
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd ok-to-stop osd.1
```

Confirm the target OSD is still HDD-only:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 0 --format json \
  | jq '{id,hostname,bluefs_dedicated_db,bluefs_single_shared_device,bluestore_bdev_devices,device_ids}'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 1 --format json \
  | jq '{id,hostname,bluefs_dedicated_db,bluefs_single_shared_device,bluestore_bdev_devices,device_ids}'
```

Confirm Kingston free space from any Turin OSD pod or the maintenance pod:

```bash
OSD2="$(
  kubectl -n rook-ceph get pod -l app=rook-ceph-osd,ceph-osd-id=2 \
    -o jsonpath='{.items[0].metadata.name}'
)"
kubectl -n rook-ceph exec "${OSD2}" -c osd -- sh -lc '
vgs --units g --nosuffix
lvs --units g --nosuffix ceph-10525ca6-66f7-48fd-a13a-7f7063dcc31b
'
```

## Pause GitOps Reconciliation

Pause Argo CD before manual OSD work. `rook-ceph` is ApplicationSet-managed and
Argo CD is self-managed, so raw `kubectl scale` changes can be reverted if the
controllers stay active.

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/skip-reconcile=true --overwrite
kubectl -n argocd annotate application argocd argocd.argoproj.io/skip-reconcile=true --overwrite
kubectl -n argocd annotate application rook-ceph argocd.argoproj.io/skip-reconcile=true --overwrite
kubectl -n argocd scale deploy argocd-applicationset-controller --replicas=0
kubectl -n argocd scale statefulset argocd-application-controller --replicas=0
```

Verify the pause:

```bash
kubectl -n argocd get sts argocd-application-controller \
  -o custom-columns=NAME:.metadata.name,SPEC:.spec.replicas,READY:.status.readyReplicas
kubectl -n argocd get deploy argocd-applicationset-controller \
  -o custom-columns=NAME:.metadata.name,SPEC:.spec.replicas,READY:.status.readyReplicas
```

Both must show `SPEC` `0`.

Leave the Rook operator running for the fast path unless it starts reconciling
against the target OSD during maintenance. The OSD deployment is stopped only
for the short BlueStore metadata edit.

## Recovery Priority During Wait Windows

If the goal is maximum recovery throughput while waiting for PGs to clean, use
custom mClock reservations. Built-in `high_recovery_ops` does not mean exactly
80 percent recovery reservation.

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- sh -lc '
ceph config set osd osd_mclock_profile custom
ceph config set osd osd_mclock_scheduler_background_recovery_res 0.800000
ceph config set osd osd_mclock_scheduler_client_res 0.100000
ceph config set osd osd_mclock_scheduler_background_best_effort_res 0.100000
ceph config set osd osd_mclock_scheduler_background_recovery_wgt 12
ceph config set osd osd_mclock_scheduler_client_wgt 1
ceph config set osd osd_mclock_scheduler_background_best_effort_wgt 1
'
```

Verify effective values:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- sh -lc '
for key in \
  osd_mclock_profile \
  osd_mclock_scheduler_background_recovery_res \
  osd_mclock_scheduler_client_res \
  osd_mclock_scheduler_background_best_effort_res \
  osd_mclock_scheduler_background_recovery_wgt \
  osd_mclock_scheduler_client_wgt \
  osd_mclock_scheduler_background_best_effort_wgt
do
  printf "%s=" "${key}"
  ceph config get osd "${key}"
done
'
```

## Create a Turin Maintenance Pod

The target OSD must be stopped while `ceph-bluestore-tool` edits its BlueStore
metadata. Because the OSD pod is stopped, run the migration commands from a
temporary privileged Ceph pod pinned to `turin`.

Use the live Ceph image:

```bash
kubectl -n rook-ceph get cephcluster rook-ceph -o jsonpath='{.spec.cephVersion.image}{"\n"}'
```

Create the maintenance pod:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: rook-ceph-turin-osd-maint
  namespace: rook-ceph
spec:
  restartPolicy: Never
  nodeName: turin
  hostPID: true
  hostNetwork: true
  tolerations:
    - operator: Exists
  containers:
    - name: ceph
      image: quay.io/ceph/ceph:v19.2.3
      command: ["sleep", "infinity"]
      securityContext:
        privileged: true
        runAsUser: 0
      volumeMounts:
        - name: dev
          mountPath: /dev
        - name: run-udev
          mountPath: /run/udev
        - name: rook-data
          mountPath: /var/lib/rook
        - name: rook-ceph-log
          mountPath: /var/log/ceph
  volumes:
    - name: dev
      hostPath:
        path: /dev
    - name: run-udev
      hostPath:
        path: /run/udev
    - name: rook-data
      hostPath:
        path: /var/lib/rook
    - name: rook-ceph-log
      hostPath:
        path: /var/lib/rook/rook-ceph/log
        type: DirectoryOrCreate
EOF

kubectl -n rook-ceph wait --for=condition=Ready pod/rook-ceph-turin-osd-maint --timeout=180s
```

## Optional LV Pre-Creation

LV creation itself does not require stopping an OSD. It can be done before the
short OSD downtime window.

```bash
kubectl -n rook-ceph exec rook-ceph-turin-osd-maint -- bash -ceu '
VG_NAME=ceph-10525ca6-66f7-48fd-a13a-7f7063dcc31b
vgs "${VG_NAME}"
lvcreate -L 300000M -n osd-db-osd0 "${VG_NAME}"
lvcreate -L 300000M -n osd-db-osd1 "${VG_NAME}"
lvs --units g --nosuffix "${VG_NAME}"
'
```

If the LVs already exist, do not recreate them. Inspect first:

```bash
kubectl -n rook-ceph exec rook-ceph-turin-osd-maint -- lvs --units g --nosuffix
```

## Migrate One OSD

Run this for `osd.0`, wait for clean PGs, then run it for `osd.1`.

Set the target OSD:

```bash
OSD_ID=0
LV_NAME="osd-db-osd${OSD_ID}"
VG_NAME="ceph-10525ca6-66f7-48fd-a13a-7f7063dcc31b"
```

Capture the OSD FSID before stopping the pod:

```bash
OSD_POD="$(
  kubectl -n rook-ceph get pod -l "app=rook-ceph-osd,ceph-osd-id=${OSD_ID}" \
    -o jsonpath='{.items[0].metadata.name}'
)"
OSD_FSID="$(
  kubectl -n rook-ceph exec "${OSD_POD}" -c osd -- cat "/var/lib/ceph/osd/ceph-${OSD_ID}/fsid"
)"
CLUSTER_FSID="$(
  kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph fsid
)"
```

Set short maintenance flags so a brief OSD stop does not start a new rebalance:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set nobackfill
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set norebalance
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd ok-to-stop "osd.${OSD_ID}"
```

Stop exactly one OSD:

```bash
kubectl -n rook-ceph scale deploy "rook-ceph-osd-${OSD_ID}" --replicas=0
kubectl -n rook-ceph wait --for=delete pod -l "app=rook-ceph-osd,ceph-osd-id=${OSD_ID}" --timeout=180s
```

Attach `block.db`, migrate BlueFS metadata, and run fsck:

```bash
kubectl -n rook-ceph exec rook-ceph-turin-osd-maint -- bash -ceu "
OSD_ID='${OSD_ID}'
OSD_FSID='${OSD_FSID}'
CLUSTER_FSID='${CLUSTER_FSID}'
VG_NAME='${VG_NAME}'
LV_NAME='${LV_NAME}'
OSD_PATH=\"/var/lib/rook/rook-ceph/\${CLUSTER_FSID}_\${OSD_FSID}\"
DB_DEV=\"/dev/\${VG_NAME}/\${LV_NAME}\"

test -d \"\${OSD_PATH}\"
test -L \"\${OSD_PATH}/block\"
test ! -e \"\${OSD_PATH}/block.db\"
test -e \"\${DB_DEV}\"

ceph-bluestore-tool show-label --path \"\${OSD_PATH}\"
ceph-bluestore-tool bluefs-bdev-new-db --path \"\${OSD_PATH}\" --dev-target \"\${DB_DEV}\"
ceph-bluestore-tool bluefs-bdev-migrate \
  --path \"\${OSD_PATH}\" \
  --devs-source \"\${OSD_PATH}/block\" \
  --dev-target \"\${OSD_PATH}/block.db\"
ceph-bluestore-tool fsck --path \"\${OSD_PATH}\"
ceph-bluestore-tool bluefs-bdev-sizes --path \"\${OSD_PATH}\"
ls -l \"\${OSD_PATH}\"/block*
"
```

Start the OSD:

```bash
kubectl -n rook-ceph scale deploy "rook-ceph-osd-${OSD_ID}" --replicas=1
kubectl -n rook-ceph rollout status deploy "rook-ceph-osd-${OSD_ID}" --timeout=300s
```

Verify the OSD adopted the DB:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata "${OSD_ID}" --format json \
  | jq '{id,hostname,bluefs_dedicated_db,bluefs_single_shared_device,bluefs_db_devices,bluefs_db_size,device_ids}'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph tell "osd.${OSD_ID}" bluefs stats
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

Acceptance for each OSD:

1. The same OSD ID is `up` and `in` under host `turin`.
1. `block.db` exists in the OSD data directory.
1. `bluefs_dedicated_db=1`.
1. `bluefs_single_shared_device=0`.
1. `bluefs_db_devices` includes `nvme2n1`.
1. `ceph tell osd.N bluefs stats` shows WAL/DB bytes on the DB device.
1. All PGs return to `active+clean` before the next OSD starts.

Unset the short rebalance blockers after the target OSD is stable if another
OSD migration is not starting immediately:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset nobackfill
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset norebalance
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noout
```

## GitOps Follow-Up

After `osd.0` and `osd.1` are migrated, update
`argocd/applications/rook-ceph/cluster-values.yaml` so future OSD prepares use
the same desired DB device. Use per-device config, not node-wide config:

```yaml
- name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LVM9
  config:
    metadataDevice: /dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B76878F0B27
    databaseSizeMB: "300000"
- name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0MZ1M
  config:
    metadataDevice: /dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B76878F0B27
    databaseSizeMB: "300000"
- name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0NL5D
  config:
    metadataDevice: /dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B76878F0B27
    databaseSizeMB: "300000"
```

Validate:

```bash
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/rook-ceph
bun run lint:argocd
```

Merge the GitOps change, then sync `rook-ceph` to the merged `main` revision.

Resume Argo if it was paused:

```bash
kubectl -n argocd scale statefulset argocd-application-controller --replicas=3
kubectl -n argocd scale deploy argocd-applicationset-controller --replicas=1
kubectl -n argocd annotate application root argocd.argoproj.io/skip-reconcile- || true
kubectl -n argocd annotate application argocd argocd.argoproj.io/skip-reconcile- || true
kubectl -n argocd annotate application rook-ceph argocd.argoproj.io/skip-reconcile- || true
```

## Rollback Boundaries

Safe rollback cases:

1. LV was created but `bluefs-bdev-new-db` was not run: remove the unused LV.
1. Maintenance pod was created but no BlueStore command ran: delete the pod.
1. OSD was stopped but no BlueStore command ran: scale the OSD deployment back
   to `1`.

Unsafe rollback cases:

1. `bluefs-bdev-new-db` succeeded but `bluefs-bdev-migrate` failed.
1. `bluefs-bdev-migrate` partially completed.
1. `ceph-bluestore-tool fsck` fails after attaching DB.

For unsafe cases, do not start the OSD. Keep the OSD stopped, preserve the DB
LV, collect:

```bash
ceph-bluestore-tool show-label --path "${OSD_PATH}"
ceph-bluestore-tool bluefs-bdev-sizes --path "${OSD_PATH}"
ceph-bluestore-tool fsck --path "${OSD_PATH}"
```

Then decide whether to repair in place or use the slower purge/reprepare
fallback. Do not improvise by deleting `block.db` after labels have been
written.

## Final Cleanup

After both OSDs are migrated and all PGs are clean:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset nobackfill
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset norebalance
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noscrub
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset nodeep-scrub
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph crash archive-all
kubectl -n rook-ceph delete pod rook-ceph-turin-osd-maint --ignore-not-found
```

Final proof:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf
for id in 0 1 2; do
  kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata "${id}" --format json \
    | jq '{id,hostname,bluefs_dedicated_db,bluefs_single_shared_device,bluefs_db_devices,bluefs_db_size,device_ids}'
  kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph tell "osd.${id}" bluefs stats | sed -n '1,20p'
done
kubectl -n argocd get app root argocd rook-ceph \
  -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REV:.status.sync.revision
```

Expected final state:

1. `HEALTH_OK`.
1. `6 osds: 6 up, 6 in`.
1. All `409` PGs `active+clean`.
1. `osd.0`, `osd.1`, and `osd.2` all report `bluefs_dedicated_db=1`.
1. `bluefs_single_shared_device=0` for all three Turin OSDs.
1. Argo `rook-ceph` is `Synced`.
