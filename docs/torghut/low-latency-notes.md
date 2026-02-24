# Low-Latency & Reliability Notes (Torghut Streaming)

> Note: Canonical production-facing design docs live in `docs/torghut/design-system/README.md` (v1). This document is supporting material and may drift from the current deployed manifests.

This doc captures tuning and operational guardrails to reach near-real-time behaviour while keeping correctness.

## Delivery semantics vs latency

- Exactly-once Kafka sink waits for checkpoints to commit transactions. For sub-500 ms tails, keep checkpoint interval short (e.g., 5-10 s) or allow an at-least-once profile (no transactions) when downstream can dedup.
- Set `transaction.timeout.ms` > checkpoint timeout + failover budget to avoid aborts during recovery.
- Consumers of TA topics should use `isolation.level=read_committed` when transactions are on.

References: Flink delivery guarantees overview (Confluent): https://docs.confluent.io/cloud/current/flink/concepts/delivery-guarantees.html

## Watermark & buffer tuning

- `pipeline.auto-watermark-interval`: 50-100 ms to emit watermarks more frequently.
- `execution.buffer-timeout`: 5-10 ms to reduce operator flush latency.
- `table.exec.source.idle-timeout`: small (e.g., 1s) so idle partitions don’t hold back watermarks.

Reference: Flink low-latency tuning guide: https://flink.apache.org/2022/05/18/getting-into-low-latency-gears-with-apache-flink-part-one/

## State backend choices

- RocksDB (with incremental checkpoints) is robust for large state; slight latency overhead.
- Heap state can reduce tail latency but lacks incremental checkpoints; good only for small-state jobs.
- Consider unaligned or concurrent checkpoints for faster recovery if backpressure appears.

Reference: Flink state backends guide: https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/state_backends/

## Checkpoint store (MinIO/S3A)

- Example properties:
  - `fs.s3a.endpoint=http://minio.torghut.svc:9000`
  - `fs.s3a.path.style.access=true`
  - `fs.s3a.connection.ssl.enabled=true|false` (match MinIO)
  - `fs.s3a.access.key` / `fs.s3a.secret.key` from K8s Secret
  - `fs.s3a.fast.upload=true`
- Set `state.checkpoints.dir` and `state.savepoints.dir` to `s3a://<bucket>/...`.
- Ensure NetworkPolicy allows egress to MinIO and the truststore includes the MinIO CA if TLS.

MinIO how-to (policy/user/bucket): https://min.io/docs/minio/linux/administration/identity-access-management.html

## Kafka client security (SCRAM/TLS)

- Set `security.protocol=SASL_SSL`, `sasl.mechanism=SCRAM-SHA-512`.
- Provide JAAS config from Strimzi KafkaUser secret; mount truststore, set `ssl.endpoint.identification.algorithm=HTTPS`.
- Avoid plaintext secrets in manifests; use sealed-secret or reflector from kafka namespace.

Kafka security best practices: https://www.openlogic.com/blog/apache-kafka-best-practices-security

## Topic/schema readiness

- Create KafkaTopic CRs before deploying Flink sinks to avoid unknown topic errors.
- Register Avro/JSON subjects in Karapace ahead of job startup; use TopicNameStrategy and backward compatibility.

Karapace usage: https://docs.aiven.io/docs/products/karapace/concepts/schema-registry

## Low-latency profile toggle

- Default profile: exactly-once sinks, transactions on, checkpoints 10 s.
- Low-latency profile: at-least-once sinks (disable transactions), buffer-timeout 5 ms, watermark interval 50 ms; downstream consumers must dedup.

## Alpaca WS constraints

- One active connection per account/endpoint; exceeding limit returns HTTP 406.
- Market stream URL: `wss://stream.data.alpaca.markets/v2/{feed}`; subscribe via JSON action `"subscribe"`.
- Keep reconnect+resubscribe logic and emit status on disconnects.

Reference: Alpaca streaming doc: https://docs.alpaca.markets/docs/streaming-market-data

## Testing & load

- Replay FAKEPACA or recorded NVDA slice into Kafka; measure end-to-end lag and consumer lag under peak expected rate.
- Validate p99 event-to-signal latency; adjust watermark slack and buffer timeout until targets met.
- Kill JM/TM to confirm recovery from checkpoint without duplicate committed outputs.
