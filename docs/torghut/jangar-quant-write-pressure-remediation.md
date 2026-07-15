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
