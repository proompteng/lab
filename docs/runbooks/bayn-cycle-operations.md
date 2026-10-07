# Bayn cycle operations

Bayn remains fail-closed. A healthy pod, a clear alert, or a terminal cycle does not grant broker or capital authority.

## Read the bounded state

1. Read `GET /v1/status` and record `build`, `executionSession`, `cycle`, `authority`, and `broker`.
2. Confirm `authority.brokerOrders=false` and `authority.capitalPromotion=false` before any OBSERVE investigation.
3. Use `cycle.current.cycleId`, `cycle.last.cycleId`, the selected sessions, cutoff, phase, and reason to correlate
   structured Bayn logs. Cycle IDs are intentionally absent from Prometheus labels.
4. Compare the durable mutation event count before and after the observation window. Do not infer zero mutation from
   readiness alone.
5. Match `executionSession.executionSessionDate` to the broker calendar and its `controllerPlanHash` to the approved
   plan. Verify the Restate controller's source revision against `build.sourceRevision` during release acceptance.
   `PREOPEN` and `WARMUP` are usable prerequisites before a full signal window exists. A completed bootstrap proves
   ownership, not session readiness. `RECOVERY_ONLY`, `BLOCKED`, `INPUT_UNAVAILABLE`, `EVALUATION_UNAVAILABLE` and
   `DECISION_LAGGING` require investigation; ordinary `ABSTAINING` does not imply a system failure.

## Trace one lifecycle pass

1. Query Tempo for `resource.service.name = "restate"`, `"bayn-execution-controller"`, and `"bayn"` over the same
   bounded window.
2. Follow the `BaynExecutionController/tick` Restate attempt into the native execution advance and
   `bayn.reconciliation.run` spans. Broker and mutation spans remain children of the Bayn execution trace.
3. Use the emitted `trace_id` and `span_id` fields to move between Tempo and the correlated JSON logs in Loki. Never
   use account identifiers, credentials, order payloads, or other high-cardinality business data as trace attributes.
   Query the bounded log stream with `{job="bayn", namespace="bayn"} |= "<trace_id>"`; the trace ID stays in the JSON
   payload rather than becoming a high-cardinality Loki label.
4. Treat a missing segment as an observability failure: verify the workload's exact source revision, its OTLP endpoint,
   and the namespace-scoped NetworkPolicy path to the Tempo distributor. A partial trace is not execution proof.

## Execution critical path

Start with the completed or failed `bayn.execution.advance` pass for the exact deployed source revision. Its JSON
log carries `controllerKey`, `epoch`, `sequence`, `sourceRevision`, `elapsedMs`, `outcome` and `stageTimings`, plus
the receipt, waiting/blocking reason and next delay on a returned outcome. A failure or interruption retains the
finished and interrupted stages after finalization. A retry has a new trace; correlate it by controller identity
and sequence instead of treating it as a second successful execution.

Use a bounded session window and the verified worker source in Tempo:

```traceql
{ resource.service.name = "bayn-execution-controller" && resource.service.version = "<source-revision>" && name = "bayn.execution.advance" && trace:duration > 5s }
```

Find the pass in Loki and inspect its profile and child stage logs:

```logql
{namespace="bayn", pod=~"bayn-execution-controller-.*"} |= "<trace_id>"
```

`stageTimings` groups only stages and operations executed in that pass. `count` reveals repeated work;
`inclusiveElapsedMs` includes child stages; `maxElapsedMs` identifies its slowest call. `failures` and
`interruptions` retain unsuccessful calls. These times overlap and must not be summed into a critical-path total.
Use the trace waterfall for ordering, parallel work and gaps. Stage profiles are scoped to each advance and do
not include the separate inference-expense background worker.

1. Separate `bayn.execution.bounded-pass` and `bayn.execution.cycle-pass` from the root advance. They retain the
   deadline and cycle scopes without repeating the root span name.
2. Inspect `bayn.execution.submit` with `bayn.operation=entry` or `close`. Slow and failed submission logs include
   `intentId` and `closeOnly`. Use the durable intent/mutation history to bind its request and order afterward.
   Keep the identifiers in log payloads and persisted evidence, not Prometheus or Loki labels.
3. Compare intent commit, final authorization and persistence with `bayn.alpaca.mutation`, whose
   `bayn.operation` is `SUBMIT` or `CANCEL`. The broker stage includes response-body completion and classification.
   Its duration is not time from signal to order acknowledgement. An interrupted or unknown response still needs
   durable recovery; do not transmit a replacement order from a timing diagnosis.
4. Distinguish connection acquisition, writer-lease acquisition/check, `BEGIN`, `COMMIT` and `ROLLBACK` spans.
   Broker persistence reuses its owned writer transaction; healthy native snapshot passes need no nested savepoints.
   Standalone store mutations acquire their own fence. A held-lock check remains a real database round trip.
5. `bayn.execution-store.operation`, `bayn.postgres.operation`, `bayn.alpaca.read` and `bayn.tigerbeetle.request`
   have bounded `bayn.dependency` and `bayn.operation` span attributes. Separate expensive operations before
   attributing all database time to commit or all broker time to transmission.
6. Compare `rate(container_cpu_cfs_throttled_periods_total{namespace="bayn"}[1m])` with
   `rate(container_cpu_cfs_periods_total{namespace="bayn"}[1m])` on the same pod/container, and inspect
   `rate(container_cpu_cfs_throttled_seconds_total{namespace="bayn"}[1m])`, CPU usage and configured limits.
   The existing collector retains these counters for Bayn. Verify fresh series and scrape health before diagnosing
   either throttling or its absence. `bayn.jev.inference` separately records the model request and response duration.

For a post-session investigation, preserve the exact time bounds, source revision, trace completeness, correlated
logs, durable cycle/intent/mutation/reconciliation records, broker state and accounting receipts in private evidence.
Check Loki/Tempo retention and query completeness before calling the session reconstructed. Missing traces,
missing CPU throttle metrics or an idle database sample remain UNKNOWN. Database waits and synchronous replication
require the measurements below; a readiness endpoint or a fast idle pass does not prove session performance.

The collector samples the `bayn-db` catalog diagnostics every five seconds and retains
`scrape_duration_seconds{job="cnpg-postgres",namespace="bayn"}`. Verify `up`, exporter collection errors and sample
timestamps for both database instances. A thirty-second or stale sample can miss an entire multi-second commit
stall; even the five-second cadence cannot attribute a shorter wait. Correlate `cnpg_bayn_waits_*`, WAL I/O counters
and replication gauges with the `COMMIT` span and the server's slow-statement timestamp. Active query age is the
age of the statement, rather than time spent in its current wait event. A missing wait sample remains UNKNOWN.

When original capture is enabled, inspect `bayn.capture.object.put_verified` for the complete conditional PUT and
exact GET/readback verification. Its `bayn.capture.object.phase` retains the phase reached when it ends:
`VALIDATING`, `CONDITIONAL_PUT`, `READBACK`, `VERIFY_BYTES` or `VERIFIED`. A failed PUT or GET and a stalled body
therefore remain distinguishable after cancellation. The span records only the dependency, operation, byte length
and phase; credentials, endpoint, bucket, object keys and raw payloads are excluded. A verified object does not prove
that its chunk committed to PostgreSQL, and an invalidated capture or unknown write outcome never qualifies a source.
These background capture spans are outside the execution-stage profile and retain the one-second object deadline.

## Alert actions

For `SNAPSHOT_STALE`, correlate `Streaming market snapshot rejected` with the pass's trace ID in Loki. Inspect its
exact `eventAt` and `ingestedAt`, `ingestionDelayDirection`, `publicationDelayMs`, and minimum or maximum publication
bound. Fresh quotes and a complete bar/feature join do not establish timely original publication. A late required
benchmark bar blocks every window that contains it; retain its source timestamps and never backdate a recovery.
Kafka bootstrap, supervision and 30-second projection measurements use the native worker's structured JSON logger.
Confirm the current Restate registration's label selector before comparing workers; retained revisions can coexist.

- `BaynMetricsUnavailable`: verify the Bayn pod, the observability Alloy pod-discovery target, and the NetworkPolicy.
  If Bayn failed before HTTP startup, inspect startup logs and compare configured provenance with the embedded
  source revision, image digest, strategy behavior hash, and strategy parameter hash.
- `BaynStatusReplicaTargetMissed`: compare the `bayn` Deployment's desired and available replicas. One surviving
  READY status pod is not full read-plane availability. Restore the missing replica and hostname spread; do not
  compensate by changing execution ownership or authority.
- `BaynEgressProxyReplicaTargetMissed`: compare the `bayn-egress-proxy` Deployment's desired and available replicas.
  Preserve both stateless proxy replicas and their hostname spread so one node loss does not remove broker read
  connectivity. Do not bypass the proxy or broaden broker egress.
- `BaynExecutionWorkerUnavailable`: inspect the Restate-managed `bayn-execution-controller-*` ReplicaSets and pods,
  then the active Restate worker revision and controller projection. Keep trading fail-closed until at least one
  configured worker is Ready; never create a second scheduler or bypass Restate to recover execution.
- `BaynExecutionWorkerReplicaTargetMissed`: compare the summed desired and Ready replicas across the
  Restate-managed `bayn-execution-controller-*` ReplicaSets. A healthy active controller with fewer Ready workers than
  desired has lost failover capacity. Restore the missing worker while preserving Restate serialization and the
  PostgreSQL writer fence; do not promote a pod to an independent writer.
- `BaynExecutionControllerOverdue`: compare the active controller's `lastSequence`, `completedAt`, and `nextDueAt` in
  `GET /v1/status`, then inspect Restate for a paused or retrying `BaynExecutionController/.../tick` invocation. Ready
  worker replicas do not prove durable execution progress. Restore the existing Restate invocation path; never create
  a replacement scheduler or bypass the PostgreSQL writer fence.
- `BaynExecutionWindowUnready`: inspect the current ACTIVE cycle, its immutable `submissionOpenAt`, and
  `executionSession.condition`. From ten minutes before submission opens until its cutoff, readiness
  requires the realized capital activation, durable execution authority with clear kill state, exact reconciliation
  covering the latest mutation, zero unresolved mutations, an account-bound/readable broker, and an active readable
  Restate controller with a matching plan and a durable completion. No snapshot binding is required before the first
  full observation. After warmup, unavailable signal inputs or inference also close readiness; input-window failures
  and decision lag have dedicated alerts. Input-window failures are excluded per replica only while all dedicated-alert
  gates qualify, preserving the generic unready signal when dedicated telemetry is incomplete. Ordinary abstention
  remains ready. Repair the failed prerequisite through its existing owner. Do not move the session window,
  force a decision, or create another execution process.
- `BaynInputWindowUnavailable`: the consumer reports `executionSession.condition=INPUT_UNAVAILABLE` for one minute
  on an ACTIVE, decision-unbound cycle, at or after `firstObservationAt` and before `submissionCutoffAt`.
  Runtime readiness, cycle projection availability, and scrape health must all be true on that same replica before
  replicas are aggregated. Check the retained pass's bounded readiness reason and required feature/window identity,
  then the existing consumer bootstrap barriers and exact raw/feature lineage. A latest-minute bar or healthy producer
  acknowledgement does not prove all 30 required minutes, matching features, or timely availability. Missing middle
  minutes, absent/mismatched/late features, and incomplete offset/bootstrap evidence can withhold the window.
  Warmup, a bound decision, cutoff, and ordinary abstention do not trigger this alert. Restore the failed input owner;
  do not relax freshness, admission, risk, or authority gates or force a trade.
- `BaynExecutionDecisionLagging`: the session preflight is healthy, but the ACTIVE cycle remains unbound after
  `bayn_cycle_decision_deadline_timestamp_seconds`. For the current Jev protocol, the first full observation is 30
  minutes and two seconds after submission opens. The deadline adds the protocol's maximum decision lag to the later
  of that observation and the attempt's creation time. Follow the current Restate tick trace through decision construction,
  risk evaluation, and the PostgreSQL decision bind. Do not synthesize a decision or submit directly to the broker.
  If no decision is durably bound by `submissionCutoffAt`, Bayn must classify the cycle as
  `MISSED_SUBMISSION_CUTOFF` and close readiness rather than wait until execution close.
- `BaynCycleObservationUnavailable`: inspect `cycle.error` in `GET /v1/status`, then restore the existing PostgreSQL
  projection path. Do not substitute cached or synthetic state.
- `BaynRuntimeDegraded`: inspect `operational`, all `dependencies` (including `cycleRunner`), `autonomousCycleLoop`,
  and the broker read/account-binding facts in `GET /v1/status`. Restore the failed dependency or the existing scoped
  loop; do not bypass OBSERVE or create a replacement scheduler.
- `BaynCycleStalled`: branch on `cycle.reason` in `GET /v1/status`. `submissionCutoffAt` remains a hard deadline for an
  ACTIVE cycle until its immutable decision is bound. A decision-bound ACTIVE cycle may continue broker recovery and
  reconciliation through `executionCloseAt`; an unbound ACTIVE cycle at the cutoff is a missed-submission incident.
- `BaynCycleFailed`: preserve `cycle.reason` and the terminal cycle identity. Resolve the underlying authority,
  reconciliation, mutation, or durable-cycle state through its existing writer contract. When
  `cycle.reason=LAST_CYCLE_BLOCKED`, branch on the exact persisted `cycle.last.terminalReason`; never clear the alert
  by editing monitoring state.

An alert clears only when its source-of-truth state changes and the next bounded projection or health probe confirms
recovery.

Missing telemetry is UNKNOWN, not a healthy input window. A stale runtime projection closes `bayn_runtime_ready`;
an unavailable cycle projection and a failed scrape have their own alerts. This rule cannot diagnose the underlying
input cause from the condition alone. Mimir ingestion uses the shared Kafka cluster, so this is not out-of-band
detection of a Kafka or storage outage. No alert here proves storage repair, strategy alpha, or permission to trade.

## Database latency investigation

The `bayn-postgres-monitoring` ConfigMap adds PostgreSQL 18 catalog queries to the existing CNPG scrape; it does not
replace the platform's default metrics. Queries run read-only under the existing metrics role, without grants to
application tables. Neither credentials, SQL text, process identifiers nor account data are exported as labels.

1. Confirm both `cnpg_bayn_io_timing_relation_enabled` and `cnpg_bayn_io_timing_wal_enabled` are one on the relevant
   primary/standby and that the scrape is healthy. A zero timing counter while collection is disabled is not proof of
   fast I/O. Inspect `cnpg_bayn_io_stats_reset_seconds` and start with rates over a bounded interval after collection
   was enabled. PostgreSQL 18 moved WAL write/sync statistics to `pg_stat_io`; do not query the removed `pg_stat_wal`
   timing columns.
2. Correlate `bayn.postgres.commit`, execution deadline/cancellation spans and database log timestamps with
   `cnpg_bayn_waits_backends`. `IPC/SyncRep` identifies synchronous acknowledgement waiting; `IO/WALSync` identifies
   WAL synchronization. A scrape samples current wait states and may miss short waits.
   `cnpg_bayn_waits_active_query_age_seconds` is query age, not time spent in its current wait state.
3. Compare primary and standby rates of `cnpg_bayn_io_write_seconds_total` and
   `cnpg_bayn_io_fsync_seconds_total` by `object` and `backend_type`, alongside the default checkpointer counters.
   Differentiate WAL flush, checkpoint file sync and relation I/O before attributing every slow commit to one cause.
4. Check connected, streaming and synchronous standby counts in `cnpg_bayn_replication_*`, recent flush-lag coverage,
   reply ages and outstanding WAL bytes. No connected standby is not zero replication latency. Flush lag can become
   null during idle periods; pair it with `measured_flush_lag_standbys` and the sender counts.
5. Correlate the same interval with the verified PVC/RBD/OSD/device mapping, Ceph commit/apply latency, recovery,
   scrubbing, device errors and competing writers. A different PVC on the same bottleneck is not storage isolation.
   Changes to another application's workload require that application's explicit authorization.

Preserve synchronous replication, `fsync`, checksums, statement cancellation and freshness bounds. Do not diagnose a
storage repair from an idle-only sample. Any changed timing overhead or database load must be measured, and the
existing durability requirements must remain true through rollout and naturally observed session traffic.

## Allocation and recovery explanations

Inspect `cycle.last.entryAllocationReason` independently of the current cycle: the next session may already exist.
`TURNOVER_BUDGET_EXHAUSTED` is a read-only explanation of the last retained zero-allocation decision, not permission
to increase the mandate. `ZERO_ALLOCATION` or absent evidence must not be upgraded to a proven turnover cause.
Immutable `TARGETS_SATISFIED` records remain unchanged. Closing existing risk may exceed the entry-admission turnover
ceiling by design; a future hard round-trip budget would require a separately reviewed policy change.

Kafka cycle-failure telemetry records only a bounded invalidation reason and recognized SDK failure codes. The first
invalidation wins even when a later SDK/cleanup event follows. A recovery event links the prior and replacement
epochs after required bootstrap barriers complete. Match these events to source freshness and controller progress;
ready pods or a recovered transport alone do not prove a valid decision window.
