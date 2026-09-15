# Torghut Data-Plane Recovery

Use this runbook after shared Kubernetes, registry, Ceph, Kafka, Postgres, and ClickHouse dependencies are available. It
covers the Torghut failure modes exposed during the 2026-08-23 cluster recovery: scheduler TigerBeetle client growth,
options archive empty-result handling, and Hyperliquid freshness-query overload.

For node, Ceph, RBD, registry, and CNI recovery, use
[`../runbooks/galactic-storage-and-workload-recovery.md`](../runbooks/galactic-storage-and-workload-recovery.md) first.

## Safety And Evidence Rules

- Diagnose shared infrastructure before restarting individual Torghut deployments.
- Treat a merged source change, promoted image, Argo sync, and pod readiness as separate delivery gates.
- Preserve market-data semantics while reducing query cost. Hyperliquid readiness is based on ingest freshness; delayed
  and replayed rows make an `event_ts` cutoff unsafe.
- A provider response containing zero options contracts can be valid. Prove the shard, observation date, durable
  checkpoint, and effectively active catalog rows before classifying it as an outage.
- Do not scale memory, relax probes, disable reconciliation, or repeatedly restart a pod to hide monotonic resource
  growth.
- Make release and rollback changes through source and GitOps. Record any emergency live override and restore it before
  closing the incident.

## Shared Preflight

```bash
kubectl -n torghut get pods -o wide
kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 40

kubectl -n argocd get applications.argoproj.io \
  torghut torghut-options torghut-hyperliquid-feed torghut-hyperliquid-runtime \
  -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n torghut get clusters.postgresql.cnpg.io torghut-db
```

If Ceph, Postgres, Kafka, ClickHouse, or the registry is unavailable, stop here and repair that dependency first. After
the dependency returns, capture each workload's image digest, source commit, restart count, and prior termination reason:

```bash
kubectl -n torghut get pods -o json | jq -r '
  .items[] |
  [
    .metadata.name,
    (.status.containerStatuses // [] | map(.restartCount) | add // 0),
    (.status.containerStatuses // [] | map(.imageID) | join(",")),
    (.status.containerStatuses // [] | map(.lastState.terminated.reason // "") | join(","))
  ] | @tsv
'
```

## Scheduler And TigerBeetle Native Client Growth

### Failure signature

- `torghut-scheduler` restarts or is OOM-killed while TigerBeetle itself remains reachable.
- scheduler RSS and high-water memory rise monotonically across health checks;
- native TigerBeetle connections grow with probe count instead of stabilizing;
- `/trading/status` may remain temporarily healthy because each short-lived protocol probe succeeds.

The protocol health path must reuse one process-local native client. It must close that client when configuration changes,
a timed-out attempt is reset, or the process shuts down. The implementation authority is
[`tigerbeetle_health.py`](../../services/torghut/app/api/health_checks/tigerbeetle_health.py).

### Immediate checks

```bash
kubectl -n torghut rollout status deploy/torghut-scheduler --timeout=180s

kubectl -n torghut get --raw \
  '/api/v1/namespaces/torghut/services/http:torghut-scheduler:8183/proxy/scheduler/readyz' | jq .

kubectl -n torghut get --raw \
  '/api/v1/namespaces/torghut/services/http:torghut-scheduler:8183/proxy/trading/status' |
  jq '.tigerbeetle_ledger | {
    ok,
    protocol_ok,
    reconciliation_ok,
    reconciliation_stale,
    last_error,
    blockers
  }'

kubectl -n torghut logs deploy/torghut-scheduler --since=30m |
  rg 'TigerBeetle|OOM|Killed|protocol health|cleanup'
```

Run the bounded protocol and ledger smoke check from
[`tigerbeetle-ledger-runbook.md`](tigerbeetle-ledger-runbook.md). Do not interpret an HTTP 200 alone as proof that the
native-client lifecycle is bounded.

### Sustained acceptance gate

Observe for at least 15 minutes at a fixed interval. Require all of the following:

- every scheduler readiness and TigerBeetle protocol sample succeeds;
- scheduler restart count stays unchanged;
- native connection cardinality stabilizes rather than increasing with sample count;
- RSS fluctuates within a bounded range instead of growing monotonically;
- the ledger smoke and reconciliation surfaces remain successful.

The 2026-08-23 accepted rollout produced 26/26 samples over 15 minutes, zero restarts, a stable three native
connections, RSS from 590,220 to 748,952 KiB, and a maximum observed high-water mark of 995,288 KiB. These values are an
incident receipt, not universal alert thresholds.

## Options Archive Empty Results

### Failure signature

- the provider returns an empty page for a bounded weekly shard;
- the archive refuses finalization because old catalog rows still appear active;
- retries continue even though every catalog row in the shard has already expired;
- Sunday or closed-session timing makes a legitimate empty response plausible.

The safeguard must count only catalog rows whose `expiration_date >= observed_date`. Rows already expired on the
observation date cannot prove that an empty provider result is unsafe. The implementation authority is
[`archive_repository.py`](../../services/torghut/app/options_lane/archive_repository.py).

### Read runtime and durable state

```bash
kubectl -n torghut get --raw \
  '/api/v1/namespaces/torghut/services/http:torghut-options-archive:80/proxy/readyz' | jq .

kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "
select
  scope_key,
  metadata->>'status' as status,
  retry_count,
  metadata->>'page_count' as page_count,
  metadata->>'seen_count' as seen_count,
  metadata->>'transitioned_count' as transitioned_count,
  last_success_ts
from torghut_options_watermarks
where component = 'catalog_archive'
  and scope_type = 'expiration_shard'
  and scope_key = '<YYYY-MM-DD/YYYY-MM-DD>';
"

kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "
select
  count(*) filter (where expiration_date < date '<OBSERVED_DATE>') as expired,
  count(*) filter (where expiration_date >= date '<OBSERVED_DATE>') as effectively_active
from torghut_options_active_contract_catalog
where expiration_date between date '<SHARD_START>' and date '<SHARD_END>';
"
```

An empty page is safe to finalize only when it is the complete response for the exact bounded shard, the query fingerprint
matches the durable checkpoint, no in-scope effectively active row makes the empty response contradictory, and the final
checkpoint reaches `complete` with no error. Never mark rows inactive based on a partial page, failed cursor, provider
error, or mismatched shard.

The recovered `2026-08-17/2026-08-23` shard completed with retry count zero, 295,536 transitions, 309,760 already-expired
rows, and zero effectively active rows.

## Hyperliquid Feed Freshness Query Overload

### Failure signature

- `torghut-hyperliquid-feed` writes continue, but `/readyz` times out or oscillates;
- readiness runs a broad ClickHouse aggregate every 30 seconds;
- query logs show tens of millions of rows and multi-GiB reads;
- the runtime becomes unready because the feed dependency is unstable.

The freshness query must restrict `_part` to active ClickHouse parts whose `modification_time` is within the ingest
readiness window plus the 60-second precision and clock-skew grace. It must not filter `event_ts`. The implementation and
regression contract are in
[`ClickHouseSink.kt`](../../services/dorvud/hyperliquid-feed/src/main/kotlin/ai/proompteng/dorvud/hyperliquid/ClickHouseSink.kt)
and
[`ClickHouseSinkTest.kt`](../../services/dorvud/hyperliquid-feed/src/test/kotlin/ai/proompteng/dorvud/hyperliquid/ClickHouseSinkTest.kt).

### Verify feed and runtime

```bash
kubectl -n torghut rollout status deploy/torghut-hyperliquid-feed --timeout=180s
kubectl -n torghut rollout status deploy/torghut-hyperliquid-runtime --timeout=180s

kubectl -n torghut get --raw \
  '/api/v1/namespaces/torghut/services/http:torghut-hyperliquid-feed:80/proxy/readyz' |
  jq '{
    ready,
    readinessBlockers,
    websocket,
    kafka,
    clickhouse,
    clickhouseTableFresh,
    clickhouseTableIngestLagMs,
    clickhouseTableEventLagMs,
    marketDataFresh
  }'

kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/readyz
kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/trading/loop/status

kubectl -n torghut logs deploy/torghut-hyperliquid-feed --since=30m |
  rg 'freshness|ClickHouse|read_rows|read_bytes|timeout'
```

Require at least 15 minutes of successful feed and runtime checks, unchanged restart counts, fresh ingest timestamps, and
bounded ClickHouse duration, rows, and bytes. Event lag and future skew remain diagnostics; ingest lag is the readiness
authority. The 2026-08-23 accepted rollout produced 46/46 feed and 46/46 runtime checks, zero restarts, and freshness
queries completing in milliseconds while reading MiB instead of the prior roughly 88 million rows and 6 GiB.

## Release, Rollback, And Closure

1. Land the source fix with focused regression coverage.
2. Wait for release automation to publish the image and update the digest and source-commit fields in GitOps.
3. Verify the live pod's image ID and embedded commit, Argo revision, endpoint behavior, and sustained gate.
4. If the gate fails, revert the source or promotion through Git and let Argo reconcile. Do not patch a live Deployment to
   an unrecorded image.
5. Preserve logs, status payloads, query-cost evidence, restart counts, memory range, and the exact observation window in
   the incident report.

The source and promotion receipts for the 2026-08-23 fixes are recorded in
[`2026-08-23-turin-nvme-ceph-and-application-recovery.md`](../incidents/2026-08-23-turin-nvme-ceph-and-application-recovery.md).
