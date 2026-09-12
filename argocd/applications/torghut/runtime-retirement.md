# Torghut runtime retirement

The September 2026 retirement removes the legacy Torghut services while retaining the market-data pipeline
used by Bayn. It does not remove the shared `torghut` Argo Application or namespace.

## Desired state

| Retired workload       | Kubernetes owner removed from the active resource set    |
| ---------------------- | -------------------------------------------------------- |
| Torghut API            | Knative Service `torghut`                                |
| Simulation API         | Knative Service `torghut-sim`                            |
| TA simulation          | FlinkDeployment `torghut-ta-sim`                         |
| Torghut PostgreSQL     | CloudNativePG Cluster `torghut-db`                       |
| Torghut ledger         | TigerBeetleCluster `torghut-tigerbeetle`                 |
| LLM guardrails metrics | Deployment and Service `torghut-llm-guardrails-exporter` |

The same change retires PostgreSQL migration, CA-reflector, TigerBeetle smoke, and whitepapers bootstrap
hooks; PostgreSQL backup scheduling; the three legacy Torghut CronJobs; historical simulation workflows
and analysis templates; and their dedicated RBAC/configuration. It removes API exposure and scraping.
Notebooks initialize with ClickHouse credentials alone. Market-data views keep reading ClickHouse; legacy
PostgreSQL and trading-status views report unavailable without connecting to retired services.

The active resources retain `torghut-ws`, live `torghut-ta`, `market-data-archive`, ClickHouse and Keeper,
notebooks, Alloy, and ClickHouse guardrail metrics. The shared runtime ServiceAccount and RBAC remain
because websocket and Flink workloads use them. Backup and checkpoint buckets, recovery objects,
credentials, and notebook volumes remain. Bayn's PostgreSQL and ledger in namespace `bayn` are unchanged.

The legacy `deploy:torghut` command exits with a retirement message before any build, migration, or cluster action,
including when `TORGHUT_SKIP_MIGRATIONS=true`. Retained workloads use normal CI, Kargo, and Argo delivery.

Inactive workload manifests remain available for recovery and existing Kargo image metadata updates.
Only the root Kustomization resource list determines which of those manifests are deployed. Restoring an
inactive manifest to that list is an operational change requiring a reviewed recovery plan.

## Rollout and preservation

1. Inventory owners, UIDs, PVCs, PV handles, snapshots, and active workflow consumers. Confirm the target is
   `galactic-lan` and the six selected workloads are in namespace `torghut`. Confirm no historical simulation
   workflow is active in `argo-workflows` before retiring its template.
2. Set only the three retiring database PVs to `Retain`, using UID, resourceVersion, and claim-UID tests.
   CloudNativePG owns its PVCs, so removing the Cluster can delete them. A retained PV preserves the
   underlying storage when its claim is removed. Do not change policies on shared or Bayn volumes.
3. Complete a native PostgreSQL snapshot backup before removing the Cluster. The retirement checkpoint is
   `Backup/torghut-db-retirement-20260912` and `VolumeSnapshot/torghut-db-retirement-20260912`, in `torghut`.
   The Backup has no owner reference to the Cluster. Its snapshot content has deletion policy `Retain`.
   Record the operator's actual backup mode; this checkpoint reports `online: true` despite the request's
   `online: false`, so do not describe it as an offline backup. The retained original PVs also preserve the
   database data through shutdown. A completed snapshot alone is not a tested restore.
4. Deploy the Jangar consumer retirement in [PR #14529](https://github.com/proompteng/lab/pull/14529)
   through its normal Kargo stage before deleting Torghut. Verify its retired API routes return HTTP 410,
   its Torghut database environment and CA mount are absent, and its retained routes still respond.
   The same prerequisite removes the API, PostgreSQL, and LLM telemetry absence alerts.
5. Validate the rendered resource set and post-deploy verifier, then merge through normal review and CI.
   All five existing image builders publish the exact source cohort. Kargo promotes that source to
   `kargo/torghut`; Argo prunes the retired owners and Kubernetes garbage-collects their dependents.
   Do not manually sync Argo, replace the shared Application, or publish a hand-written image bump.
6. Verify all six owners, their Pods, API Services, and dependent scheduled consumers are absent. Inspect
   any terminal hook remnants against the pre-removal UID inventory before normal deletion. Never strip
   finalizers, force-delete storage, delete a namespace, or delete objects using a broad name prefix.
7. Verify recovery volumes and backups still exist, both retained Flink jobs are running with completed
   checkpoints, websocket/Kafka and ClickHouse reads work, and Bayn and Ceph remain healthy. During a
   closed market, report the market-data check's observation mode rather than claiming fresh trading ticks.

The new backup and PV preservation metadata are recovery objects, not recurring acceptance applications.
The PostgreSQL and whitepapers buckets remain declared so removing a workload cannot remove its data.

## Retained database volumes

| Original claim               | PV                                         | Capacity |
| ---------------------------- | ------------------------------------------ | -------- |
| `torghut-db-1`               | `pvc-be2c74ec-7079-4088-a76f-bbd80d087571` | 50 GiB   |
| `torghut-db-2`               | `pvc-fe139016-e8cb-41cf-a0ab-5edad1352bdb` | 50 GiB   |
| `data-torghut-tigerbeetle-0` | `pvc-95d99cdd-e4f5-4271-9ad6-4fad8df549d2` | 100 GiB  |

TigerBeetle's StatefulSet declares `Retain` for both PVC deletion and scale-down. Its PV is also protected.
PostgreSQL PVs can become `Released` after their Cluster-owned PVCs disappear. Preserve their claim
references, CSI handles, and metadata in the operational evidence; do not automatically clear or rebind them.
The previous PostgreSQL upgrade snapshots and native object-store backups remain available.

## Recovery

A Git revert alone is insufficient for PostgreSQL recovery: recreating the Cluster after its claims disappear
could initialize a new database. Restore with CloudNativePG's documented snapshot or object-store recovery
configuration into separately named claims first, validate the database, and only then restore consumers.
Alternatively, deliberate recovery of retained original PVs requires verifying their CSI handles, former claim
UIDs, and PostgreSQL instance roles before rebinding. Never mount the same database data writable twice.

Recover TigerBeetle with the retained PVC or a verified copy, the original cluster ID `2001`, and a compatible
TigerBeetle version. Restore simulation only from its own checkpoint prefix. The live TA and archive
checkpoint prefixes are separate and must remain untouched. Keep trading disabled during any restoration.

The post-deploy workflow checks the deployed revision, directly checks retired Deployment/Knative Service
and Pod absence, and checks other retired owners through Argo's resource inventory using existing runner
permissions. The rollout operator additionally verifies those owners directly. For each retained Flink
pipeline, the workflow requires ready JobManager and TaskManager Pods running the immutable image
from the verified Argo revision in Git, including manual runs checked out on another branch. It rejects a
healthy job left on an older image, accounts for every task
as running or successfully finished, and requires a completed checkpoint, then runs the existing Kafka,
websocket, and TA freshness check with `TORGHUT_SCHEDULER_EXPECTED=false`.

References: [Kubernetes retained volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#retain)
and [CloudNativePG snapshot recovery](https://cloudnative-pg.io/documentation/current/recovery/).
