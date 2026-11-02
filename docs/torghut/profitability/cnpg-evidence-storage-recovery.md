# CNPG Evidence Storage And Recovery

Status: Slice 11 recovery, availability, and live query-envelope proof is production-complete. The Torghut Argo
application remains independently `Progressing` because the notebook Tailscale ingress has not been provisioned; that
access-policy rollout is not storage proof and must not be hidden by declaring the whole application healthy.

## Observed Baseline

The live readback on `2026-07-18` found a healthy 21 GB PostgreSQL 17 database with data checksums, continuous WAL
archiving, a 14-day recovery window, and successful daily object-store backups. The latest base backup completed in
about 15 minutes. It also found three material gaps:

- the cluster had one instance, so there was no failover replica;
- an old `kubectl-patch` manager still pinned the pod to one hostname even though that selector was absent from Git;
- no isolated restore or measured recovery-time proof existed.

Backup success is not restore proof. One healthy pod and one Ceph-backed PVC are not database high availability.

## Decision

Run one primary and one hot standby on the two amd64 workers, with required hostname anti-affinity. Do not place a
physical replica on the arm64 worker until mixed-architecture compatibility is deliberately proven with the exact
PostgreSQL image and data types. The current two-instance topology is asynchronous: it improves availability but does
not claim zero-loss synchronous failover.

Each instance has a `500m` CPU and `1Gi` memory request plus a `4` CPU and `8Gi` memory limit. Those bounds are above
the observed primary use of roughly `379m` CPU and `453Mi` memory while preventing an unbounded database pod from
consuming a worker. Base backups prefer the standby and fall back to the primary when no standby is available.

Planned primary updates use `primaryUpdateMethod: switchover`. The first two-instance rollout exposed why this must be
explicit: the operator defaulted to an in-place smart shutdown, the write endpoint rejected connections for about
3 minutes 13 seconds, and the singleton scheduler became ready again about 4 minutes 31 seconds after the interruption
started. No trade decision, broker-mutation receipt, or mutation event was created during the interruption, but that
downtime is not an acceptable planned-update contract when a ready replica exists.

CloudNativePG manages `instances - 1` replicas and automated failover whenever `instances` is greater than one. Its
backup guidance states that WAL archiving provides a default disaster-recovery RPO of at most five minutes and that
restore time must be measured regularly. See the official
[capability-level contract](https://cloudnative-pg.io/docs/current/operator_capability_levels/) and
[backup guidance](https://cloudnative-pg.io/docs/current/backup/).

## Ownership Migration

Argo CD uses server-side apply with forced conflict resolution, but omitting a map entry does not delete a value still
owned by another field manager. The rollout therefore has one explicit operational migration after the Git change is
merged and before judging replica placement:

```sh
kubectl -n torghut patch cluster torghut-db --type=json \
  -p='[{"op":"remove","path":"/spec/affinity/nodeSelector"}]'
```

This removes only the stale scheduling pin. It does not restart, delete, or recreate the primary. The committed
architecture affinity and required hostname anti-affinity then become the only scheduling contract. Verify the result
through `metadata.managedFields`, the live Cluster spec, and pod node placement; do not retain a cleanup Job or second
configuration writer. After the one-time patch, omit `nodeSelector` from Git; a null sentinel is not valid against the
CNPG schema once the legacy map no longer exists.

If Argo has already raised `instances` before the field-ownership patch lands, CNPG may create an unschedulable join Job
whose immutable pod template still contains the old hostname. Confirm that the join pod never started and that the PVC
is only marked `initializing`; then delete that generated join Job and the empty replica PVC so CNPG can rebuild them
from the corrected Cluster spec. Never delete the primary pod or primary PVC. This is the operator's supported replica
rebuild boundary, not a recurring controller or cleanup path.

## First HA Rollout Evidence

The `2026-07-18` rollout cloned 23,655,938,048 bytes in about 12 minutes. The resulting primary and replica were ready
on different amd64 hosts with zero container restarts. Direct `pg_stat_replication` readback reported `streaming`,
`async`, and zero byte replay lag after catch-up. Both pods applied the bounded resource contract. Continuous archiving
and the latest completed backup remained healthy, and direct CNPG readback found no new trade decisions or broker
mutations during the rollout.

## Production Proof Sequence

Slice 11 is complete only after all of these pass:

1. focused manifest tests, Kustomize rendering, CRD server dry-run, and CI pass at the merged source;
2. the operator reports two ready instances on distinct amd64 hosts, streaming replication is healthy, and the standby
   lag is measured rather than assumed;
3. a controlled weekend switchover preserves database identity and immutable evidence counts, the read-write Service
   follows the new primary, and the scheduler reconnects without duplicate broker mutation;
4. a base backup completes from the standby and continuous WAL archiving remains healthy;
5. a new isolated CNPG cluster restores the selected backup, verifies database/schema and immutable evidence
   fingerprints, records recovery duration, and is then removed without touching the source cluster.

The isolated restore follows CloudNativePG's rule that recovery bootstraps a new cluster rather than overwriting the
source. See the official [recovery contract](https://cloudnative-pg.io/docs/current/recovery/).

The installed CloudNativePG `1.30.0` operator warns that native Barman object-store support is removed in `1.31`.
Migration to the supported Barman Cloud CNPG-I plugin is therefore a blocking follow-up before the next operator
upgrade; backup availability must not be silently lost during that upgrade.

## Standby Backup, Switchover, And Restore Evidence

The controlled `2026-07-18` proof completed all destructive-risk work against isolated or redundant capacity:

- `Backup/torghut-db-ha-proof-20260718` ran on standby `torghut-db-2` from `13:00:21Z` to `13:12:02Z` and completed
  with end LSN `881/FE0A7450`;
- a controlled promotion made that standby primary, moved the read-write endpoint, restored a healthy two-instance
  topology with zero replay lag, and produced no duplicate trade decision or broker mutation;
- an isolated one-instance cluster restored Barman backup ID `20260718T130021` with `targetImmediate: true`. The base
  restore and WAL replay completed in 8 minutes 49 seconds, and the cluster became ready in 9 minutes 1 second;
- recovery stopped at the backup-end LSN, with the last completed transaction at `13:11:38.162862Z`. The restored
  database retained the source system identifier, 21 GB database size, data checksums, Alembic revision
  `0082_order_lineage_runs`, and the 1,656-column schema fingerprint;
- full-row canonical hashes and counts matched for `broker_economic_ledger_entries` (1,336,109),
  `broker_mutation_receipt_events` (269), `broker_mutation_receipts` (34), `evidence_receipts` (56), and
  `execution_order_events` (15,428).

For a `targetImmediate` restore, use `Backup.status.backupId` (`20260718T130021` here), not
`Backup.status.backupName`. The admission webhook requires that ID even when `bootstrap.recovery.backup.name` already
references the exact Kubernetes Backup object. The restore cluster had no application route and no backup stanza, so
it could neither receive Torghut traffic nor write into the source archive.

## Measured Query Envelope

The live statistics history showed repeated full scans of `hyperliquid_execution_orders`. The table held only 4,290
rows, but the affected reads sit on status and fill-ingestion paths, so their cumulative work matters. The restored
copy was analyzed and used to benchmark the exact SQL from `loop_status.py`, `reporting.py`, and `repository.py`.

| Query                       | Baseline buffers / time | Measured index buffers / time | Result                              |
| --------------------------- | ----------------------: | ----------------------------: | ----------------------------------- |
| latest acknowledged order   |           59 / 0.147 ms |                  3 / 0.014 ms | 95% fewer buffers; about 10x faster |
| orders in the last 24 hours |          283 / 0.469 ms |                  2 / 0.011 ms | 99% fewer buffers; about 43x faster |
| exchange-order lookup       |          283 / 0.330 ms |                  3 / 0.018 ms | 99% fewer buffers; about 18x faster |

The projected-volume check used the same PostgreSQL 17 image, production column types and status mix, and a 512-byte
row-width pad in a disposable CNPG cluster. Its 1,000,000 rows were about 233 times the live order count and occupied a
651 MB heap (780 MB including the pre-existing indexes).

| Projected-volume query       | Baseline buffers / time | Measured index buffers / time |
| ---------------------------- | ----------------------: | ----------------------------: |
| latest acknowledged order    |     83,425 / 341.228 ms |                  9 / 0.024 ms |
| orders in the last 24 hours  |     83,334 / 114.007 ms |              4,327 / 1.694 ms |
| exchange-order lookup        |     83,334 / 108.565 ms |                  4 / 0.021 ms |
| rejection cooldown (30 days) |      25,024 / 84.645 ms |             3,573 / 20.384 ms |

Two B-tree indexes produced those results: `(execution_network, created_at DESC)` and the partial
`(execution_network, exchange_order_id, created_at DESC) WHERE exchange_order_id IS NOT NULL`. Together they occupied
336 KiB on the restored data and 51 MB on the projected fixture. Stale-open-order latency remained below 0.1 ms, and
the rejected-order operator report remained below 125 ms at projected volume; neither justified another index. The
projected fixture and all of its resources were removed after measurement. Production creation uses
`CREATE INDEX CONCURRENTLY` to avoid blocking writes, consistent with the PostgreSQL 17
[index-build contract](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

## Live Migration And Rollout Closure

PR `#12807` merged as `1fc0c210b17fb6bfd87c9ab7dab9b438a169eead`, and promotion PR `#12808` merged as
`8d1e28ad3500d2cf0668b4987049bc3e7d529798`. The PreSync migration hook upgraded both the production and default
simulation databases from `0082_order_lineage_runs` to `0083_hyperliquid_order_reads`. Direct primary readback found
both indexes `indisvalid=true` and `indisready=true`; the migration rejects an invalid or incomplete concurrent-index
artifact instead of allowing Alembic to stamp over it.

Production `EXPLAIN (ANALYZE, BUFFERS)` then proved the exact runtime reads use the intended indexes:

| Query                       | Live buffers | Live execution time |
| --------------------------- | -----------: | ------------------: |
| latest acknowledged order   |            3 |            0.045 ms |
| orders in the last 24 hours |            2 |            0.018 ms |
| exchange-order lookup       |            3 |            0.011 ms |

The promoted scheduler rolled with `Recreate`, remained a one-replica writer, reacquired healthy leadership, and
reported fresh successful trading and reconciliation cycles with zero restarts. The new Knative API revision became
active at `14:22:42Z`; its predecessor became inactive at `14:23:21Z`, bounding readiness overlap to 39 seconds and
leaving every retained older revision at zero replicas. Direct database checks found no trade decision, broker
mutation receipt/event, Hyperliquid order, or Hyperliquid fill created during the rollout window. CNPG remained two of
two ready with asynchronous streaming current, continuous archiving healthy, and the promoted primary on a different
amd64 host from its replica.

None of these storage proofs establishes strategy profitability or capital authority. Risk-increasing real-capital
submission remains blocked.
