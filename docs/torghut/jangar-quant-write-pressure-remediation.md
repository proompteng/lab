# Jangar Quant Write-Pressure Remediation

## Decision

Replace append-only pipeline-health persistence with a primary-keyed latest-state table, suppress unchanged latest-metric
updates, and reduce quant-series persistence from five-second to one-minute samples. Keep the one-second compute loop and
all trading/alert semantics unchanged.

This is an application write-amplification fix. It does not increase Kafka timeouts, weaken PostgreSQL durability, or
assume a hardware fault.

## Production evidence

At `2026-07-15T03:43Z`, the storage stability gate failed after seven minutes with:

- 24 KRaft request timeouts;
- 125 controller events above two seconds; and
- a healthy Ceph cluster with every PG active and clean.

A live ten-sample `rbd perf image iostat` capture showed the active controller image at roughly 50-400 ms write latency.
The shared `replicapool` was writing about 6.8 MiB/s and 325 operations/s with replication size two. The Jangar primary
and asynchronous replica were the largest sustained writers, so one logical PostgreSQL workload was consuming write I/O
on both Ceph storage hosts.

Jangar's quant tables explained the avoidable portion of that load:

Over a measured 30.182-second interval, Jangar generated 18.204 MiB of PostgreSQL WAL, or 0.603 MiB/s, before this
change. That is the rollout baseline for the primary and asynchronous replica RBD images.

| Table                   | Live footprint | Persistence behavior before this change               |
| ----------------------- | -------------: | ----------------------------------------------------- |
| `quant_metrics_latest`  |         22 MiB | Unconditional conflict update on every computed frame |
| `quant_metrics_series`  |        156 GiB | Append every five seconds per strategy/account/window |
| `quant_pipeline_health` |         21 GiB | Append three rows on every computed frame             |

Every pipeline-health reader selects only the newest row for a strategy, account, window, and stage. Retaining every
historical heartbeat in PostgreSQL therefore adds no runtime capability.

## Post-rollout physical-I/O finding

The first rollout reduced a clean 30-second Jangar WAL sample to **0.181 MiB/s**, below the 0.3015 MiB/s gate. That
average did not make the shared storage path stable. Kafka controller 2 still produced two-to-seven-second controller
events while controllers 0 and 1 timed out Raft fetches.

Live PostgreSQL and RBD evidence isolated the remaining Jangar cost:

- `quant_metrics_series` contains about 7.47 million live rows whose recent and oldest samples average only 188-192
  bytes each, but the relation occupies 146 GiB;
- the heap is 78 GiB and its indexes are 68 GiB: 48 GiB for the lookup index, 16 GiB for the random-UUID primary key,
  and 3.8 GiB for the global `as_of` index;
- active series inserts wait on PostgreSQL `DataFileRead`, proving that index pages are no longer a cache-resident hot
  write set; and
- during a fresh RBD sample, the Jangar replica issued 110 small writes/s at 229 ms average latency and the primary
  issued 67 writes/s at 252 ms. An unrelated registry image write had the most bandwidth in that sample, so it is not a
  clean baseline, but Jangar remained the largest small-write IOPS source.

The old five-second sampling regime created and later removed far more index entries than the current live row count.
Ordinary vacuum can make dead space reusable but cannot shrink those B-trees. Reindexing or `VACUUM FULL` would scan or
rewrite the live 146 GiB relation on the already contended pool, so neither is an acceptable incident-time operation.

### No-copy active-series cutover

The next migration therefore performs only metadata and empty-table work:

1. Rename the existing table to `quant_metrics_series_legacy`; its rows and indexes remain untouched.
2. Create a logged `quant_metrics_series_active` table hash-partitioned 16 ways by `strategy_id`. Queries always provide
   a strategy ID, so partition pruning keeps the active lookup index set bounded without a calendar-partition time bomb.
3. Give the active table only the required strategy/account/window/metric/time lookup index plus a compact BRIN time
   index. Do not recreate the unused random-UUID primary-key or global time B-tree write costs.
4. Recreate `quant_metrics_series` as a `UNION ALL` compatibility view over legacy and active history.
5. Route inserts on that view to the active table with an `INSTEAD OF INSERT` trigger. Both the new image and the prior
   image keep the same read/write contract, so an image rollback does not lose access to either side of the cutover.

The forward migration does not select from, copy, reindex, vacuum, truncate, or delete the legacy relation. Its reverse
path first merges active rows back by UUID before restoring the original table name, preserving data if an explicit
database rollback is required. A five-second local lock timeout makes the metadata cutover fail closed instead of
waiting behind a long analytical query.

## Implementation

### Latest metrics

`quant_metrics_latest` keeps its existing key and freshness contract. Its conflict update now executes only when the
material row tuple is distinct from the stored tuple. Identical retries produce no heap or index rewrite.

### Pipeline health

The migration creates `quant_pipeline_health_latest` with primary key
`(strategy_id, account, window, stage)`. It intentionally does not scan or copy the 21 GiB legacy table: pipeline health
is derived state, and the running loop repopulates active scopes within one five-second sampling interval.

Writers upsert the latest row and refresh `updated_at`. Readers use the explicit indexed `window` column instead of a
JSON expression plus `DISTINCT ON`. The legacy append-only table remains untouched for rollback and is dropped only in a
separate cleanup after live read/write proof.

### Series sampling

The compute loop remains at one second, while historical series persistence changes from five seconds to 60 seconds.
The shortest supported analytical window is one minute, so this preserves the available temporal resolution while
reducing series inserts by up to 12 times. Stream updates, current metrics, alerts, and on-demand materialization remain
independent of this history sampling interval.

## Rollout gates

1. Verify the migration creates the empty latest-state table without reading the legacy table.
2. Verify Jangar becomes ready and active health scopes populate within five seconds.
3. Verify quant health and snapshot APIs preserve their response contracts.
4. Compare Jangar WAL rate and both Jangar RBD image write rates with the 0.603 MiB/s pre-change WAL baseline.
5. Require the shared RBD pool and Kafka controllers to complete a new 30-minute observation with no request timeout,
   broker fencing, slow controller event above two seconds, or sustained ISR loss.
6. Only after the observation passes, proceed with the bounded Options archive activation.

## Rollback and cleanup

Rollback restores the previous image and five-second manifest value; the legacy pipeline-health table remains available
throughout that window. Do not drop or truncate it in the activation migration.

After the new path soaks and repository/runtime searches prove no legacy readers or writers, a follow-up migration may
drop `quant_pipeline_health`. Historical quant-series retention and partitioning are a separate storage-lifecycle change;
this rollout only stops the immediate high-frequency growth.
