# Jangar Quant Write-Pressure Remediation

## Decision

Replace append-only pipeline-health persistence with a primary-keyed latest-state table, suppress unchanged latest-metric
updates, bound latest-state persistence to ten seconds, and remove the unused quant-series API, writer, and relations.
Keep the one-second compute loop and all trading/alert semantics unchanged.

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

### Quant-series removal

The no-copy active-series cutover was used as containment while production usage was verified. Repository search found
no Jangar UI, Torghut runtime, trading, alert, or control-plane caller of the historical-series endpoint. Live
PostgreSQL statistics confirmed the absence of a production reader: since the statistics reset, the legacy relation had
only 11 index scans, and the most recent composite-key lookup was the cutover verification itself; active-relation reads
were the bounded rollout diagnostics.

The final migration is therefore intentionally destructive and roll-forward only. It uses a five-second local lock
timeout, drops the compatibility view and insert function, then drops the active partition tree and the retained 146 GiB
legacy table without broad `CASCADE`. The API route, writer, store queries, database types, runtime state, and
configuration are removed in the same image. No Torghut trading or alert contract depends on this data.

### Latest-state write budget

The compact-series rollout completed at `2026-07-15T06:08Z`. It reduced steady Jangar RBD traffic from roughly 67/110
primary/replica writes per second to 19/15, but two independent 60-second WAL samples still measured **0.391 MiB/s** and
**0.387 MiB/s**. Per-table PostgreSQL statistics in those same windows identified the remaining source:

- `quant_metrics_latest`: 33,012 and 30,816 updates per minute;
- `quant_pipeline_health_latest`: 2,208 and 2,301 updates per minute; and
- `quant_metrics_series_active`: 4,464 and 4,464 inserts per minute.

The one-second compute target is therefore not used as a database-write target. Latest-state persistence is sampled at
ten seconds per strategy/account/window while compute, alert evaluation, stream deltas, and on-demand materialization
remain immediate. A process restart and an on-demand request both force a complete latest-state write before the
sampling clock resumes. The health payload records whether each frame persisted latest state so the write budget is
observable rather than implicit.

## Implementation

### Latest metrics

`quant_metrics_latest` keeps its existing key and freshness contract. Its conflict update now executes only when the
material row tuple is distinct from the stored tuple. Identical retries produce no heap or index rewrite. The main loop
attempts that upsert no more than once per ten seconds per frame; direct materialization still writes immediately.

### Pipeline health

The migration creates `quant_pipeline_health_latest` with primary key
`(strategy_id, account, window, stage)`. It intentionally does not scan or copy the 21 GiB legacy table: pipeline health
is derived state, and the running loop repopulates active scopes within one five-second sampling interval.

Writers upsert the latest row and refresh `updated_at`. Readers use the explicit indexed `window` column instead of a
JSON expression plus `DISTINCT ON`. The legacy append-only table remains untouched for rollback and is dropped only in a
separate cleanup after live read/write proof.

### Series removal

The compute loop remains at one second. Historical-series persistence and reads no longer exist: there is no API route,
runtime append path, store function, environment toggle, or database relation. A future approved historical analytics
requirement must be designed against an explicit consumer and retention contract rather than silently restoring this
unbounded PostgreSQL cache.

## Rollout gates

1. Verify the migration creates the empty latest-state table without reading the legacy table.
2. Verify Jangar becomes ready and active health scopes populate within five seconds.
3. Verify the quant-series route returns 404 and all four series relations/functions are absent.
4. Verify quant health and snapshot APIs preserve their response contracts.
5. Compare Jangar WAL rate and both Jangar RBD image write rates with the 0.603 MiB/s pre-change WAL baseline.
6. Require the shared RBD pool and Kafka controllers to complete a new 30-minute observation with no request timeout,
   broker fencing, slow controller event above two seconds, or sustained ISR loss.
7. Only after the observation passes, proceed with the bounded Options archive activation.

## Rollback and cleanup

The quant-series deletion is irreversible. After that migration applies, an image rollback to code that expects the
series table is prohibited; recovery is roll-forward only. The legacy pipeline-health table remains available during
this slice and is not dropped or truncated by the quant-series migration.

After the new path soaks and repository/runtime searches prove no legacy pipeline-health readers or writers, a follow-up
migration may drop `quant_pipeline_health`.
