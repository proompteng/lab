# Torghut Streaming Architecture

## Goals
- Near real-time technical analysis (≤300–500 ms event-to-signal).
- Reliable ingestion from Alpaca WS with automatic reconnect/dedup.
- Exactly-once delivery in analytics path; ordering preserved per symbol.
- Operate under Alpaca single-connection-per-account constraint.
- Security-first: SASL/TLS to Kafka, no plaintext secrets in git, runAsNonRoot/read-only rootfs, scoped egress.
- Observability-first: lag, reconnects, checkpoint age, sink txn failures, consumer lag.

## High-level Flow

```mermaid
flowchart LR
  A[Alpaca Market WS<br/>trades/quotes/bars] -->|JSON frames| FWD
  FWD[Kotlin WS Service<br/>Gradle multi-project (platform/ws/ta)] -->|Kafka producer<br/>acks=all,lz4| K1[(Kafka topics<br/>trades/quotes/bars/status)]
  K1 --> FL[Apache Flink Job<br/>KafkaSource+Watermarks]
  FL -->|micro-bars 1s| K2[(ta.bars.1s.v1)]
  FL -->|EMA/RSI/MACD/VWAP/etc| K3[(ta.signals.v1)]
  FL -->|status| K4[(ta.status.v1)]
  K2 --> CH[(ClickHouse ta_microbars)]
  K3 --> CHS[(ClickHouse ta_signals)]
  subgraph Infra
    OP["Flink K8s Operator"]
    STR["Strimzi Kafka"]
    MINIO["Checkpoint Store<br/>MinIO/S3-compatible"]
  end
  FL -.->|checkpoints| MINIO
  FL -.-> OP
  FWD -.->|status| K4
```

## Components
- WS service (Gradle multi-project):
  - `platform`: shared Kotlin/JVM library for config, logging, Kafka, JSON/Avro helpers.
  - `ws`: Ktor (or similar) WebSocket ingress that connects to Alpaca, dedups (trade `i`, quote/bar `(t,symbol)`), wraps events in the shared envelope, and produces to Kafka with acks=all, lz4, idempotent producers.
  - `ta`: shared indicator utilities and schemas for downstream consumers (distinct from the Flink TA job; Flink still produces derived topics).
  - Single replica per Alpaca account to satisfy the single-connection constraint.
- Kafka: Strimzi-managed, SASL/TLS; topics lz4, RF=3, partitions=1 per symbol.
- Flink: 1.20.x via Operator 1.13.x; KafkaSource/Sink with exactly-once; checkpoints every 10 s to MinIO/S3.
- torghut main service: does **not** consume TA topics; TA is used via ClickHouse-backed APIs and external consumers.

### Version matrix
- Alpaca WS: `wss://stream.data.alpaca.markets/v2/{feed}`; one active connection per account.
- Kafka: Strimzi 0.49.x (Kafka 4.1); Kafka connector 4.x compatible.
- Flink: 1.20.x runtime; Operator 1.13.x.
- Checkpoint store: MinIO/S3 via `s3a://`.
- WS service runtime: Kotlin/JVM (JDK 21), Ktor WS client, kotlinx-serialization/Avro, kafka-clients 4.x; coroutines with structured concurrency.

### Latency budget (p99 ≤500 ms)
- WS frame → forwarder ingress: ~5–30 ms
- Forwarder dedup + produce (linger 20–50 ms): ~40–80 ms
- Kafka transit: ~5–20 ms
- Flink watermark wait (goal 1–2 s slack): dominates tail; tune as stability improves
- Flink compute + sink txn: ~50–120 ms
- Downstream consume: ~10–30 ms

### Failure modes & handling
- WS disconnect: exponential backoff reconnect; status topic emits reason/attempt.
- Duplicate frames: per-type dedup cache; metric `dedup_dropped_total`.
- Kafka produce errors: retry with backoff; readiness fails on sustained errors.
- Flink JM/TM crash: restore from latest checkpoint; transactional sink prevents duplicates to committed readers.
- Checkpoint store outage: alerts on checkpoint age; job resumes from last good checkpoint after store recovers.

## Contracts (envelope)
- Fields: `ingest_ts`, `event_ts`, `feed`, `channel`, `symbol`, `seq`, `payload`, `is_final?`, `source`, `window{}`.
- Topic retention: trades/quotes 7d; bars 30d; signals 14d; status 7d (compaction optional).
- Schema: Avro or JSON with Karapace; subject name strategy per-topic; backward-compatible evolution.

## Security
- Kafka auth via Strimzi KafkaUser (SCRAM/TLS) mounted in torghut namespace (reflector allowed).
- Pods runAsNonRoot, readOnlyRootFS, drop NET_RAW; scoped NetworkPolicies (egress Alpaca + Kafka + MinIO).
- Current state: Kafka client connections in torghut use `SASL_PLAINTEXT` (no TLS). This is acceptable for now and should be revisited if we require in-cluster encryption.

## Observability
- Expose Prometheus-format metrics; existing stack is Grafana Mimir/Loki/Tempo (see `argocd/applications/observability`).
- Key metrics: WS reconnects, lag (now-event_ts), checkpoint age, sink txn failures, consumer lag.
- Dashboards in Grafana: WS lag histogram, Kafka consumer lag, Flink watermark vs event time, checkpoint duration/age, sink txn failure rate.
- Alerts (via Mimir/Alertmanager): reconnect rate > N/min, p99 lag > 500 ms, checkpoint age > 2× interval, sink txn failures > 0 over 5m, JM/TM restarts.

## Secrets & Rotation
- Alpaca: sealed-secret in torghut; rotate by updating SealedSecret and restarting forwarder. Avoid logging keys; env-only.
- KafkaUser: Strimzi-managed SCRAM/TLS secret; reflect into torghut namespace if needed; rotate via Strimzi user password change (triggers secret update) then restart clients.
- MinIO checkpoint creds: stored as Secret in torghut; rotate by updating Secret and restarting FlinkDeployment after a fresh checkpoint/savepoint.
- Document rotations in runbook; avoid plaintext commits.

## Checkpoint Bucket Provisioning
- Create bucket (e.g., `flink-checkpoints`) in MinIO tenant; enable versioning if desired.
- Create MinIO user with policy scoped to that bucket; store access/secret in K8s Secret (`fs.s3a.access.key`, `fs.s3a.secret.key`).
- NetworkPolicy must allow egress from Flink pods to MinIO service; truststore must include MinIO CA if TLS.

## Upgrade / Rollback (Flink TA)
- Preferred: savepoint or last-state upgrade.
- Steps: trigger savepoint, update image tag, deploy; verify running; if bad, redeploy prior tag with `state: last-state` or restore from savepoint.
- Abort strategy: stop job with `--drain` to flush sink transactions before rollback when possible.

## Environment / Overlay Strategy
- Kustomize overlays per env (dev/stage/prod): endpoints (Alpaca paper vs live), MinIO endpoint/bucket, Kafka bootstrap, checkpoint URI, alert thresholds.
- Keep topics/schemas identical across envs; vary retention/replication if needed.

## Feature Flags for Consumers
- External consumers should gate TA consumption (enable/disable, choose topic/version).
- Consumers should set `isolation.level=read_committed` when sinks use transactions; fallback to at-least-once profile supported via config.

## Multi-symbol Scaling Plan
- Short term: shared TA topics keyed by `symbol` with partitions=1; add symbols via forwarder/consumer config (no new topics).
- Medium term: increase partitions, shard symbols across partitions, and update Flink parallelism accordingly.
- Keep watermark/idle-timeout tuned to avoid stuck watermarks on sparse symbols.

## Data Quality & Monitoring
- Track last `event_ts` by symbol, message gaps, and count per window; alert on staleness.
- Validate `seq` monotonicity per symbol; emit to status topic on violation.
- Add canary consumer to compare TA output lag vs raw input lag.

## Tracing / Log Correlation
- Include `symbol`, `channel`, `event_ts`, `seq`, `source`, `trace_id` (generated) in logs to link forwarder→Flink→consumer; Loki labels on these fields.

## Rollout Notes
- Apply operator first (#1913), then forwarder (#1914), then TA job (#1915).
- Ensure checkpoint bucket/secret provisioned before TA job sync.
- Create KafkaTopic CRs and register schemas before enabling sinks to avoid topic/subject missing errors.
- Keep external consumers behind a feature flag until TA signal quality is validated.

## Related docs
- Forwarder details: `docs/torghut/alpaca-forwarder.md`
- Flink TA job: `docs/torghut/flink-ta.md`
- Topics & schemas: `docs/torghut/topics-and-schemas.md`
- Low-latency tuning: `docs/torghut/low-latency-notes.md`
- Runbooks: `docs/torghut/runbooks.md`
- Network/RBAC: `docs/torghut/network-and-rbac.md`
- CI/CD: `docs/torghut/ci-cd.md`
- Argo: `docs/torghut/argo.md`
- Test harness: `docs/torghut/test-harness.md`
