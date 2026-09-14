# Tempo 3 migration

Production runs Tempo 3 against the existing `tempo-traces` bucket. The
`tempo-compatibility-services.yaml` Services preserve the original distributor,
gateway, and query-frontend addresses while selecting Tempo 3 Pods. Tempo 2
and the temporary migration Vulture are retired after the gates below pass.
The existing 48-hour block retention remains unchanged.

## Admission and deployment

- Verify the running Tempo 2 configuration writes `vParquet4` blocks and uses
  the internal RGW TLS endpoint. Record ingester Pod UIDs, flush queues, retry
  counters, and a successful real trace ID before changing routing.
- Require the Kafka-owned `observability.tempo.traces.v1` topic Ready with
  three partitions, replication factor three, and minimum ISR two. Check
  the listener contract: this deployment uses the internal `plain2` listener
  on port 9093 without SASL; port 9092 requires SCRAM credentials. Check
  cluster capacity for the complete overlapping deployments and rolling surges.
- Render the observability application with Helm 3. Existing resources must
  remain unchanged during the additive deployment. Keep the original bucket,
  credential references, retention, and Tempo 2 ingester `OnDelete` strategy.
- Merge the parallel deployment through normal GitOps. Its configuration
  ConfigMaps sync before the native Tempo `-config.verify=true` Job; the new
  workloads start only after verification succeeds. Do not bypass a failure.
- Keep compaction disabled in Tempo 3 defaults and every tenant override
  while the Tempo 2 compactor remains active. Match block-builder and
  live-store counts to the three Kafka partitions.

## Acceptance and cutover

Require all new components Ready, active live stores, healthy Kafka ISR,
successful object-store reads, and increasing block-builder progress. Initial
live-store readiness can take up to 30 minutes while Kafka watermarks advance.
The migration Vulture sends synthetic traces and exercises trace-by-ID,
TraceQL search, and metrics queries. Its later sync wave and readiness init
container prevent synthetic writes before the distributor and query frontend
are ready. Recreate the single fixture writer when its template changes to
avoid overlapping test processes. Preserve failed-window evidence and begin
a fresh observation window after correcting any startup failure.
Its own Ready condition only proves its
metrics endpoint is available: require at least 15 minutes of increasing
`tempo_vulture_trace_total` with no increase in `tempo_vulture_trace_error_total`
or `tempo_vulture_error_total`
after the Tempo deployment becomes Ready.

Query the captured historical Tempo 2 trace through the Tempo 3 query frontend
and verify its trace ID, service, span, and test marker. Also write a fresh
trace directly to the new distributor and read it back exactly. Check the
shared bucket contains readable new blocks before switching production routes.

Change ingestion and query consumers through a separate reviewed GitOps
change. Verify writes reach Kafka, reads use Tempo 3, and the old distributor
receives no new traffic. Preserve the old ingesters until all buffered traces
are durably flushed: require zero live traces and flush queues, no new flush
failures, and successful historical reads. Allow the configured maximum block
duration plus complete-block timeout when observing the drain. Alternatively,
after verifying that no writes reach the old ingesters, invoke each original
Pod's native `POST /flush` handler. Tempo 2.9 cuts every remaining head block
and schedules its durable upload without stopping the process. Fence each
request by its original Pod UID, and require an increased successful-block
counter, empty flush queue, no failures or retries, zero live traces, and an
unchanged trace-created counter before retiring that Pod. Preserve the
per-Pod receipt and repeat historical queries; an HTTP 204 alone is insufficient.

Stop the old compactor before enabling Tempo 3 compaction. Verify the old
process is gone before merging that change. After old ingestion is drained,
remove the old release and the temporary migration Vulture through GitOps;
preserve every object-store bucket and repeat fresh and historical queries.

## Recovery

Before production cutover, leave production routing on Tempo 2 and correct
the new deployment. After cutover, keep Kafka, the new block builders, and all
shared objects intact. Tempo 2 cannot serve new RF1 blocks written by Tempo 3,
so routing back to Tempo 2 is not a complete rollback. Recover the Tempo 3
read/write path without deleting Kafka records, buckets, or buffered traces.
Never allow both compaction implementations to write to the bucket together.

Upstream contracts: [Tempo 3 migration](https://grafana.com/docs/tempo/latest/set-up-for-tracing/setup-tempo/migrate-to-3/)
and [Tempo Vulture](https://grafana.com/docs/tempo/latest/operations/tempo-vulture/).

The forced-flush contract comes from the exact [Tempo 2.9 handler](https://github.com/grafana/tempo/blob/v2.9.0/modules/ingester/flush.go).
