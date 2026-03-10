# Rook-Ceph RBD Metadata Incident 2026-03-10

This runbook captures the separate RBD incident discovered after the successful BlueStore metadata migration on
`talos-192-168-1-85` and `talos-192-168-1-203`.

This is not a Talos node-health issue and not a cluster-wide Ceph outage.

## Current cluster state

At the time this incident note was written:

1. all three Talos control-plane nodes were `Ready`
1. `ceph -s` returned `HEALTH_OK`
1. all six OSDs were `up/in`
1. all PGs were `active+clean`

The cluster-level migration was complete. The remaining failure domain was a subset of RBD-backed PVCs in
`replicapool`.

## Symptoms

Affected pods showed one of three patterns:

1. `MountVolume.MountDevice failed ... Failed as image not found`
1. `'fsck' found errors on device /dev/rbdX but could not correct them`
1. `applyFSGroup failed ... bad message` or repeated ext4 checksum errors on a mapped `rbd` device

Representative examples seen live:

1. `app/app-db-1`, `forgejo/forgejo-db-1`, `torghut/torghut-db-1`, `temporal/data-temporal-cassandra-1`
   1. `internal RBD image not found: rbd: ret=-2, No such file or directory`
1. `registry/registry-data`, `inngest/inngest-db-1`
   1. `fsck found errors on device /dev/rbdX but could not correct them`
1. `observability/observability-mimir-ingester-0`, `observability/observability-mimir-store-gateway-0`
   1. `bad message`
1. `temporal/data-temporal-cassandra-2`
   1. repeated ext4 checksum errors on `/dev/rbd11`

## Scope

`replicapool` contained `78` Kubernetes RBD PV images at the time of verification.

`rbd ls -l replicapool` could open only `9` images and failed to open `69`.

Broken-image counts by namespace:

1. `agents`: `25`
1. `jangar`: `7`
1. `observability`: `6`
1. `temporal`: `5`
1. `huly`: `4`
1. `torghut`: `4`
1. `posthog`: `3`
1. `kafka`: `3`
1. `coder`: `2`
1. `forgejo`: `2`
1. `forgejo-runners`: `2`
1. `keycloak`: `1`
1. `app`: `1`
1. `pgadmin`: `1`
1. `feature-flags`: `1`
1. `inngest`: `1`
1. `tsag`: `1`

Critical stateful PVCs confirmed broken:

1. `app/app-db-1`
1. `forgejo/forgejo-db-1`
1. `jangar/jangar-db-1`
1. `torghut/torghut-db-1`
1. `kafka/data-kafka-pool-a-{0,1,2}`
1. `temporal/data-temporal-cassandra-{0,1,2}`
1. `observability/observability-grafana`
1. `observability/storage-observability-mimir-{alertmanager-0,compactor-0,ingester-{0,1,2},store-gateway-0}`
1. `posthog/posthog-db-1`
1. `coder/coder-cluster-1`
1. `keycloak/keycloak-db-1`

## Evidence: missing RBD metadata objects

The broken-image pattern was consistent:

1. `rbd ls -l replicapool` still listed the image names, but `rbd info replicapool/<image>` failed with
   `No such file or directory`
1. the RBD directory OMAP still contained `name_<image>` entries
1. the corresponding `rbd_id.<image>` objects were missing
1. the corresponding `rbd_header.<id>` objects were also missing

This means the pool still remembers the image names, but the per-image metadata objects needed to open the image are
gone.

### Healthy example

`registry/registry-data`:

1. image name: `csi-vol-0b93afd9-7273-4d72-8110-8d5b000056aa`
1. `rbd_id.csi-vol-0b93afd9-7273-4d72-8110-8d5b000056aa` exists
1. `rbd_header.254fedd3dc8da` exists

### Broken example

`app/app-db-1`:

1. image name: `csi-vol-69ce3d34-a57c-4aeb-828c-dfd05880f308`
1. `name_csi-vol-69ce3d34-a57c-4aeb-828c-dfd05880f308` exists in `rbd_directory`
1. that OMAP entry resolves to id `241041a8a4fc0b`
1. `rbd_id.csi-vol-69ce3d34-a57c-4aeb-828c-dfd05880f308` is missing
1. `rbd_header.241041a8a4fc0b` is missing

Example verification commands:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- rbd ls -l replicapool

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- rbd info \
  replicapool/csi-vol-69ce3d34-a57c-4aeb-828c-dfd05880f308

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- rados -p replicapool stat \
  rbd_id.csi-vol-69ce3d34-a57c-4aeb-828c-dfd05880f308

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- sh -c '
rados -p replicapool getomapval rbd_directory \
  name_csi-vol-69ce3d34-a57c-4aeb-828c-dfd05880f308 - | od -An -tx1 | tr -d " \n"
'

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- rados -p replicapool stat \
  rbd_header.241041a8a4fc0b
```

## Evidence: some broken images still had live mapped devices

Even though the RBD metadata plane was broken, some images were still kernel-mapped through the CSI RBD nodeplugins.
That creates a salvage window as long as those mappings remain alive.

Mapped broken images observed on `talos-192-168-1-194`:

1. `kafka/data-kafka-pool-a-2` -> `/dev/rbd0`
1. `huly/datadir-cockroach-2` -> `/dev/rbd1`
1. `coder/coder-cluster-1` -> `/dev/rbd10`
1. `temporal/data-temporal-cassandra-2` -> `/dev/rbd11`
1. `forgejo-runners/data-forgejo-runners-amd64-0` -> `/dev/rbd2`
1. `observability/storage-observability-mimir-ingester-1` -> `/dev/rbd5`
1. `observability/storage-observability-mimir-compactor-0` -> `/dev/rbd6`
1. `observability/storage-observability-mimir-alertmanager-0` -> `/dev/rbd7`
1. `temporal/elasticsearch-master-elasticsearch-master-2` -> `/dev/rbd8`
1. `keycloak/keycloak-db-1` -> `/dev/rbd9`

Mapped broken images observed on `talos-192-168-1-85`:

1. `torghut/chi-data-chi-torghut-clickhouse-default-0-1-0` -> `/dev/rbd0`
1. `jangar/open-webui` -> `/dev/rbd10`
1. `feature-flags/feature-flags` -> `/dev/rbd13`
1. `forgejo/forgejo-db-1` -> `/dev/rbd3`
1. `huly/datadir-cockroach-1` -> `/dev/rbd4`
1. `temporal/data-temporal-cassandra-0` -> `/dev/rbd6`
1. `observability/storage-observability-mimir-ingester-0` -> `/dev/rbd8`
1. `kafka/data-kafka-pool-a-1` -> `/dev/rbd9`

Non-destructive checks confirmed these mapped devices were still readable at the block level and still had ext4
signatures:

```bash
kubectl -n rook-ceph exec rook-ceph.rbd.csi.ceph.com-nodeplugin-p67wx -c csi-rbdplugin -- \
  blkid /dev/rbd3 /dev/rbd6 /dev/rbd8 /dev/rbd9 /dev/rbd11
```

This is why the incident must be treated separately from node health: a mapped device can stay readable after the RBD
metadata objects needed for a fresh mount are lost.

## Immediate operational boundary

Until salvage is complete for any still-needed mapped broken image:

1. do not reboot `talos-192-168-1-85` or `talos-192-168-1-194`
1. do not restart the RBD CSI nodeplugin pods on those nodes
1. do not delete the affected pods if their mapped block devices are still the only accessible copy

If a mapped broken image is unmapped before data is copied elsewhere, the block-level salvage window may close.

## Separate filesystem-corruption cases

A smaller set of images still opened as RBD images but had filesystem-layer damage:

1. `registry/registry-data`
1. `inngest/inngest-db-1`
1. `observability/storage-observability-mimir-ingester-0`
1. `observability/storage-observability-mimir-store-gateway-0`
1. `temporal/data-temporal-cassandra-2`

Those require a different workflow than the metadata-loss cases:

1. preserve a raw copy first if possible
1. then attempt read-only mount, `fsck`, or application-aware repair

## Recovery decision tree

### 1. Broken image is still mapped

This is the best salvage case.

Recommended order:

1. identify the mapped `/dev/rbdX`
1. copy the raw block device to a safe destination before any restart or unmap
1. create a new healthy RBD image or alternative backup target
1. restore the copied data into a new volume and rebind the workload

### 2. Broken image is not mapped, but `name_<image>` still exists

This is a metadata-loss case with no live device handle.

Observations from this incident:

1. many broken images still had `name_<image>` directory entries
1. some also still had `rbd_data.<id>.*` objects
1. but the matching `rbd_header.<id>` objects were gone

Examples confirmed live:

1. `app/app-db-1`
   1. id `241041a8a4fc0b`
   1. `30` `rbd_data.<id>.*` objects still present
1. `jangar/jangar-db-1`
   1. id `2410412cb8e29c`
   1. `4278` `rbd_data.<id>.*` objects still present
1. `torghut/torghut-db-1`
   1. id `24104124cccb09`
   1. `358` `rbd_data.<id>.*` objects still present
1. `temporal/data-temporal-cassandra-1`
   1. id `2410411f5a8228`
   1. `580` `rbd_data.<id>.*` objects still present
1. `observability/observability-grafana`
   1. id `64e2da4ae518d`
   1. `72` `rbd_data.<id>.*` objects still present

That is a potential low-level recovery path, but it is not a routine Rook or CSI workflow. Treat it as manual Ceph
forensics / reconstruction work, not a normal day-two operation.

### Validated in-place repair workflow

This incident validated a same-name reconstruction workflow for broken images where:

1. the Kubernetes PV still points at the original CSI image name
1. `name_<image>` still exists in `rbd_directory`
1. `rbd_id.<image>` and `rbd_header.<id>` are missing
1. `rbd_data.<old_id>.*` objects still exist

Workflow used:

```bash
# 1. Resolve old image id from the directory OMAP entry
rados -p replicapool getomapval rbd_directory name_<image> -

# 2. Remove stale directory keys for the broken image name/id
rados -p replicapool rmomapkey rbd_directory name_<image>
rados -p replicapool rmomapkey rbd_directory id_<old_id>

# 3. Recreate a fresh image under the same original CSI image name
rbd create replicapool/<image> --size <size> --image-feature layering

# 4. Read the new image id
rbd info --format json replicapool/<image>

# 5. Copy all old data objects onto the new image prefix
for obj in $(rados -p replicapool ls | grep "^rbd_data\\.<old_id>\\."); do
  new_obj=${obj/<old_id>/<new_id>}
  rados -p replicapool cp "$obj" "$new_obj"
done
```

This keeps the original CSI image name intact, so the existing PV/PVC references do not need to be changed.

### Images repaired at the metadata layer during this incident

The workflow above was applied live to:

1. `app/app-db-1` -> `csi-vol-69ce3d34-a57c-4aeb-828c-dfd05880f308`
1. `jangar/jangar-db-1` -> `csi-vol-592052dd-679d-41a8-b112-ffc02d2ee8e2`
1. `torghut/torghut-db-1` -> `csi-vol-2fdf17af-f3af-4c50-ba08-954d883b9b7d`
1. `temporal/data-temporal-cassandra-1` -> `csi-vol-6a0f4454-e44c-405d-acb3-16a588bee08d`
1. `observability/observability-grafana` -> `csi-vol-5c63bb98-9975-4e00-996c-19f9be0be705`

Observed outcomes immediately after repair:

1. `temporal/data-temporal-cassandra-1` advanced to `Running`
1. `app/app-db-1`, `torghut/torghut-db-1`, and `observability/observability-grafana` advanced from
   `image not found` to manual ext4 `fsck` failures
1. `jangar/jangar-db-1` advanced from `image not found` to application/container startup failures

That is still progress: those PVCs are no longer blocked on missing RBD metadata.

### Important caution from the live repair

If Kubernetes remounts the reconstructed image before the object-copy phase is finished, a workload may briefly see a
partially restored or effectively empty filesystem.

Operational rule:

1. quiesce the workload first when possible
1. complete the object copy
1. then restart or remount the pod

### 3. Image opens, but the filesystem is damaged

This is not an RBD-header problem. Treat it as block-device or filesystem repair:

1. preserve a raw copy if the data matters
1. inspect with read-only tools
1. use `fsck` or application-specific recovery only after the copy exists

## Likely cause

Inference from the live evidence:

1. the BlueStore migration itself completed successfully
1. the incident was discovered after the `203` OSD recreation and incomplete-PG recovery work
1. the broken pattern was concentrated in RBD metadata objects inside `replicapool`
1. stale `rbd_directory` entries plus missing `rbd_id` and `rbd_header` objects are consistent with metadata-object
   loss rather than simple CSI cache inconsistency

Treat this as a real data-loss incident in `replicapool`.

## What to save with the incident

Preserve at minimum:

1. `ceph -s`
1. `ceph health detail`
1. `ceph pg dump pgs_brief`
1. `rbd ls -l replicapool`
1. the list of broken PVCs and any mapped `/dev/rbdX` salvage handles
1. application-level recovery notes for each restored or abandoned PVC

## Related runbooks

1. [rook-ceph-bluestore-metadata-migration.md](/Users/gregkonush/.codex/worktrees/5adc/lab/docs/runbooks/rook-ceph-bluestore-metadata-migration.md)
1. [rook-ceph-on-talos.md](/Users/gregkonush/.codex/worktrees/5adc/lab/docs/runbooks/rook-ceph-on-talos.md)
