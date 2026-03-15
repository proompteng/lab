# Incident Report: Rook-Ceph BlueStore Relayout, RBD Metadata Loss, and Multi-Application Database Outage

- **Date**: 10-11 Mar 2026 (UTC)
- **Detected by**: operator-led Ceph maintenance, subsequent Kubernetes mount failures, ext4 checksum errors, and widespread Argo CD application degradation
- **Reported by**: gregkonush
- **Services Affected**: Ceph (`rook-ceph`), RBD-backed stateful workloads in `app`, `forgejo`, `jangar`, `torghut`, `temporal`, `observability`, `huly`, `posthog`, `keycloak`, `coder`, `inngest`, `kafka`, and `tsag`
- **Severity**: Sev-1
- **Incident Class**: operator-caused storage outage during production relayout

## Executive Summary

This outage was triggered by a live production Ceph relayout on a two-host Rook-Ceph cluster. The maintenance goal was
valid: move BlueStore DB/WAL for the six HDD OSDs onto NVMe on `talos-192-168-1-85` and `talos-192-168-1-203`.
However, the change was executed directly on the live cluster, OSDs were recreated under real workload, and break-glass
Ceph recovery actions were required to clear incomplete PGs and resume service.

After Ceph returned to `HEALTH_OK`, a second-order data-loss incident was discovered in `replicapool`: many Kubernetes
RBD images still had directory entries, but the underlying `rbd_id.*` and `rbd_header.*` metadata objects were gone.
That broke fresh mounts for a large set of PVCs even though the cluster itself looked healthy. A second object-store
problem also existed in RGW: several CNPG/Loki/Tempo/Mimir backup buckets still answered bucket-level metadata calls,
but large-object `GET`, `LIST`, and `COPY` operations failed or returned inconsistent fragments.

The result was a stacked outage:

1. Ceph maintenance degraded cluster availability.
1. RBD metadata loss broke block-backed databases and stateful applications.
1. RGW metadata inconsistency broke backup-based restore paths for some services.
1. Some applications then required their own secondary recovery, such as Elasticsearch cluster reset, ClickHouse
   schema recreation, or full Cockroach rebootstrap.

The outage lasted roughly 24 hours because storage returned before applications did, and several applications needed
independent recovery after Ceph itself was healthy.

## Impact Summary

- Ceph maintenance required live OSD replacement on both storage hosts.
- `replicapool` had widespread RBD image metadata loss after the relayout window.
- `69` of `78` Kubernetes RBD images failed to open at one point during the incident.
- Affected applications ranged from mount failure to filesystem corruption to forced scratch rebuild.
- At least one RGW object was explicitly reverted with `mark_unfound_lost revert` during Ceph recovery.
- Not every database could be restored from its pre-incident backup path because RGW bucket metadata was also damaged.

## User-Facing Symptoms

From the platform surface, the outage looked inconsistent:

1. Ceph later reported `HEALTH_OK`, but application PVCs still failed with `image not found`, `fsck`, `bad message`,
   or ext4 checksum errors.
1. Some applications had all pods `Running` but were still operationally broken because they held stale config or
   partial cluster state.
1. Argo CD showed a mix of `Healthy`, `Progressing`, `Degraded`, and `OutOfSync`, depending on whether the recovery had
   already been backported to GitOps.

Representative errors observed live:

1. `internal RBD image not found: rbd: ret=-2, No such file or directory`
1. `applyFSGroup failed ... readdirent ... bad message`
1. `EXT4-fs error ... iget: checksum invalid`
1. `ListWorkflowExecutions failed ... all shards failed`
1. Cockroach startup corruption (`TEMP_DIR.LOCK`, `connection lost`)

## Root Cause

This was an operator-caused outage initiated by a live Ceph storage relayout.

Primary causes:

1. **Production OSD relayout on a two-host Ceph cluster**
   - BlueStore metadata was moved from HDD-only layout to host-local NVMe by recreating OSDs on the live cluster.
   - The cluster had only two storage hosts, so maintenance had limited safety margin and no third failure domain.

2. **Break-glass Ceph PG repair during the relayout window**
   - After OSD recreation on `203`, Ceph recovery required direct PG/object-store repair steps.
   - Those steps restored cluster availability, but the later `replicapool` damage shows the data plane did not return
     intact for all RBD images.

3. **RBD metadata loss in `replicapool`**
   - Broken images still had `name_<image>` entries in `rbd_directory`.
   - Corresponding `rbd_id.<image>` and `rbd_header.<id>` objects were missing.
   - Fresh mounts could not open those images even though some old kernel mappings still existed.

4. **Independent RGW bucket metadata inconsistency**
   - Some backup buckets still passed `HEAD Bucket` and even `HEAD Object`.
   - Large object `GET`, `LIST`, and `COPY` operations failed or returned incomplete multipart/shadow state.
   - This made normal backup-driven restore unsafe or impossible for some services.

## Direct Operator Mistakes

These were the material mistakes in execution:

1. The relayout was performed directly on production instead of being rehearsed against an equivalent cluster or backed
   by a proven rollback path.
1. Existing OSDs were recreated on a two-host cluster without a separate validated recovery drill for the exact Ceph
   PG-failure modes that followed.
1. Break-glass Ceph repair restored cluster health first, but application-level data integrity was not immediately
   audited before continuing with more recovery actions.
1. Live cluster mutations and GitOps reconciliation diverged during the incident, so Argo drift became part of the
   operational burden instead of a source of truth.
1. Per-application impact tracking was too loose early in the outage, which slowed prioritization and lengthened time to
   a clean application recovery ledger.

## Contributing Factors

1. **Two-host storage topology**
   - Replication factor `2` on only two storage hosts provides less operational slack during destructive OSD work.

2. **Mixed storage failure modes**
   - The incident was not “just Ceph” or “just application corruption”.
   - Block-volume metadata loss and object-store metadata loss existed together.

3. **Mapped-device salvage window obscured final data state**
   - Some broken RBD images still had live kernel mappings.
   - That preserved a short-lived salvage path, but also made it easy to overestimate real recoverability.

4. **Application stacks had multiple state layers**
   - `torghut`, `temporal`, and `observability` each depended on more than one stateful subsystem.
   - Fixing one database was not enough to restore the service.

## What Was Not the Root Cause

1. Talos node health was not the lasting issue; all three Talos control-plane nodes returned healthy.
1. The final steady-state Ceph cluster was healthy; the prolonged outage came from application data-path damage after
   the Ceph relayout window.
1. `froussard` was not part of the database outage; its later failure was a separate runtime/image packaging problem.

## Approximate Timeline

| Phase | Event |
| --- | --- |
| 2026-03-10 | Live BlueStore metadata relayout begins on `85` and `203`; OSDs are recreated to adopt NVMe DB/WAL. |
| 2026-03-10 | Ceph recovery stalls on incomplete PGs; break-glass OSD/PG repair is used to restore cluster availability. |
| 2026-03-10 | Ceph returns to `HEALTH_OK`, but Kubernetes workloads begin failing fresh RBD mounts with `image not found`, `fsck`, and ext4 corruption symptoms. |
| 2026-03-10 | Investigation confirms `replicapool` RBD metadata loss: `rbd_directory` name entries exist while `rbd_id.*` and `rbd_header.*` objects are missing. |
| 2026-03-10 into 2026-03-11 | Recovery splits into app-specific tracks: RBD metadata repair, filesystem repair, fresh PVC rebuilds, and RGW bucket cutovers. |
| 2026-03-11 | `observability`, `torghut`, `temporal`, and `huly` each require separate follow-up recovery beyond the initial Ceph repair. |
| 2026-03-11 | Most stateful apps return to runtime service, but several remain `OutOfSync` because incident fixes have not yet been fully ported into GitOps. |

## Database and Application Damage Ledger

This table is the core postmortem deliverable. It records the known storage damage, the recovery path used, and the
best-known outcome at the time this report was written.

| Application | Database / state layer | Observed failure | Recovery used | Data outcome | State at report time |
| --- | --- | --- | --- | --- | --- |
| `app` | CNPG Postgres (`app-db-1`) | RBD metadata loss, then ext4/fsck errors after metadata reconstruction | Manual RBD metadata repair plus volume-level recovery | Prior database preserved well enough to resume service; no separate scratch rebuild recorded | `Synced Healthy` |
| `forgejo` | CNPG Postgres (`forgejo-db-1`) | RBD image missing during incident window | Volume recovered enough for DB pod to return | DB is serving again; repository-level audit still required because this report does not prove logical integrity | `OutOfSync Healthy` |
| `jangar` | CNPG Postgres + RGW backup path | Live DB volume damaged; normal CNPG restore path also compromised by RGW metadata damage | Database service restored, but old backup chain on damaged RGW path could not be trusted as a clean restore source | Service returned; backup trust on pre-incident bucket path was lost and had to be re-established separately | `OutOfSync Healthy` |
| `torghut` | CNPG Postgres + ClickHouse + ClickHouse Keeper + Flink checkpoint bucket | RBD damage on `torghut-db-1`, broken RGW buckets, stale Knative revision config, missing ClickHouse schema/Keeper | Fresh recovery buckets/secrets, Knative revision refresh, ClickHouse Keeper recovery, schema recreate, Flink switched to stateless recovery, `ta-sim` suspended | Live trading path recovered; old checkpoint/archive lineage on damaged buckets was abandoned | `OutOfSync Healthy` |
| `temporal` | Cassandra + Elasticsearch visibility | Cassandra ordinal PVC damage and later Elasticsearch cluster UUID split | Fresh rebuild of `temporal-cassandra-2`, metadata repair for another Cassandra volume, then reset of `elasticsearch-master-2` PVC | Cassandra ordinal `2` and Elasticsearch node `2` data were rebuilt; service restored | `Synced Healthy` |
| `observability` | Grafana PVC + Loki/Tempo/Mimir object buckets | Grafana block-volume damage plus RGW bucket metadata corruption for Loki/Tempo/Mimir | New recovery buckets for Loki/Tempo/Mimir/Mimir ruler/alertmanager; workload restarts and Grafana volume recovery | Runtime observability stack restored; old bucket set retired from production use | `OutOfSync Progressing` |
| `huly` | CockroachDB (`cockroach-0/1/2`) | Multiple PVCs corrupted; cluster unrecoverable in place | Full scratch rebuild of the 3-node Cockroach cluster and bootstrap job rerun | Prior Huly Cockroach data was lost | `Synced Healthy` |
| `posthog` | Postgres (`posthog-db-1`) | RBD metadata loss in affected namespace set | Volume restored enough for DB pod to run again | Service returned, but no independent logical audit is captured in this report | `OutOfSync Healthy` |
| `keycloak` | Postgres (`keycloak-db-1`) | Broken mapped image during incident window | Volume recovered enough for DB pod to run again | Service returned; logical data audit not separately captured here | `Synced Healthy` |
| `coder` | Postgres (`coder-cluster-1`) | Broken mapped image during incident window | Volume recovered enough for DB pod to run again | Service returned; logical data audit not separately captured here | `Synced Healthy` |
| `inngest` | Postgres (`inngest-db-1`) | Filesystem-level damage (`fsck` path) | Filesystem/volume recovery sufficient to remount | Service returned; no scratch rebuild recorded | `Synced Healthy` |
| `kafka` | Broker PVCs (`data-kafka-pool-a-{0,1,2}`) | Broker PVCs were in the broken-image set during the incident | Brokers eventually resumed after storage recovered | Kafka returned to service; this report does not prove zero message loss across the entire incident window | `Synced Healthy` |
| `tsag` | App DB (`tsag-db-1`) | Namespace appeared in broken-image set during incident window | Service returned after storage recovery | Service is back, but Argo reconciliation still needs cleanup | `Unknown Progressing` |
| `forgejo-runners` | Runner StatefulSet data volumes | Affected mapped images observed during incident | Runners recovered after storage returned | Runner state is disposable/ephemeral compared with core databases | `Synced Healthy` |

## Application-Specific Notes

### `observability`

`observability` had dual damage:

1. block-volume damage on Grafana / Mimir PVCs
1. RGW bucket metadata damage for Loki, Tempo, and Mimir object storage

Production was recovered by moving the stack to fresh buckets:

1. `loki-data-recovery-20260311`
1. `tempo-traces-recovery-20260311`
1. `mimir-blocks-recovery-20260311`
1. `mimir-alertmanager-recovery-20260311`
1. `mimir-ruler-recovery-20260311`

### `torghut`

`torghut` had the deepest stack-specific damage:

1. Postgres volume damage
1. RGW archive/checkpoint bucket damage
1. stale Knative revision environment
1. missing ClickHouse schema
1. missing ClickHouse Keeper endpoints

This is why `torghut` stayed down long after Ceph itself was healthy.

### `temporal`

`temporal` required two distinct fixes:

1. Cassandra ordinal replacement after block-volume damage
1. Elasticsearch cluster repair after a stale persisted cluster UUID left one node in the headless service but outside
   the real ES cluster

The second problem explains why Temporal Web could still fail after Cassandra looked healthy.

### `huly`

`huly` is the clearest hard data-loss case in this incident. The Cockroach cluster was not repaired in place. It was
deleted and rebuilt from scratch, and the bootstrap job recreated only the base DB/user objects needed to run the
service again.

## Why the Outage Lasted Roughly 24 Hours

1. The first success condition was wrong.
   - Ceph returning to `HEALTH_OK` did not mean the application storage plane was healthy.

2. The failure was discovered in layers.
   - First Ceph/OSD recovery.
   - Then RBD metadata loss.
   - Then filesystem corruption.
   - Then RGW metadata damage.
   - Then per-application state repair.

3. Several applications needed more than one stateful system repaired.
   - `torghut`, `temporal`, and `observability` each had multi-system dependencies.

4. GitOps lagged the live recovery.
   - The incident response used direct cluster mutation to restore service.
   - Those changes were not all immediately carried back into Git, so Argo status stayed noisy and increased operator
     load.

5. Evidence collection early in the outage was incomplete.
   - The response needed a database/app impact ledger from the beginning, not after most of the storage work was done.

## Current State at Time of Report

At report drafting time:

1. all Talos control-plane nodes are healthy
1. Ceph itself is healthy
1. the major stateful apps listed above are serving again except for GitOps drift and non-database follow-up items
1. Argo is not fully green yet because some emergency live fixes still need clean GitOps reconciliation

This means the storage emergency is over, but the GitOps cleanup and residual app validation work are not.

## Preventive Actions

1. Ban live production OSD relayout on this two-host Ceph cluster without a rehearsed rollback and an app-by-app blast
   radius plan.
1. Require an explicit preflight checklist before storage work:
   - list all RBD-backed PVCs
   - list all RGW-backed restore/archive buckets
   - verify backup restore by real `GET`, not only `HEAD`
   - define which workloads may be rebuilt from scratch
1. Add a mandatory incident ledger template covering:
   - app
   - backing data store
   - current symptom
   - last known good backup
   - rebuild vs preserve decision
1. Treat `ceph -s == HEALTH_OK` as necessary but not sufficient.
   - Post-storage-change acceptance must include mount tests and application-level smoke tests for the highest-value
     stateful apps.
1. Bring live recovery changes back into Git immediately or disable autosync until the repo catches up.
1. Run post-incident logical data audits on:
   - `forgejo`
   - `posthog`
   - `keycloak`
   - `coder`
   - `inngest`
   - `kafka`
   - `tsag`
1. Add a dedicated Ceph disaster-recovery drill for:
   - OSD recreation on a two-host cluster
   - PG incomplete recovery
   - RBD metadata verification
   - RGW bucket metadata verification

## Lessons Learned

1. Storage health and application recoverability are different acceptance criteria.
1. In a stateful platform, “service restored” without “data integrity audited” is not the end of the incident.
1. Object storage must be validated at object-read level, not only bucket existence or metadata level.
1. The recovery plan must name which applications can be rebuilt from scratch before the outage starts, not after.

