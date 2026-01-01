# torghut Main Service Consumer Guide (Deprecated)

> **Status (2026-01-01):** The main torghut service no longer consumes TA topics. This doc is retained for reference only if a future consumer is added.

## Purpose
How the main torghut service should consume TA outputs and switch sources safely.

## Topics to consume
- `torghut.ta.signals.v1` (primary)
- `torghut.ta.bars.1s.v1` (optional for charts)

## Client config
- `enable.idempotence=true` (producer, if writing responses) — not required for consumer.
- `isolation.level=read_committed` when TA sink uses transactions (default profile).
- `auto.offset.reset=latest` for steady state; `earliest` for backfill/replay tools.
- SASL/TLS from Strimzi KafkaUser secret; truststore mounted; set `ssl.endpoint.identification.algorithm=HTTPS`.

## Feature flag
- Add a flag (e.g., `TA_SIGNALS_ENABLED`) to gate consumption.
- Allow selection of topic name or schema version (v1) to ease migrations.

## Payload handling
- Expect envelope fields: `event_ts`, `ingest_ts`, `symbol`, `seq`, `is_final`, `window`, `payload`.
- Be tolerant to additive fields (backward-compatible Avro/JSON).
- Use `event_ts` for ordering; `seq` for monotonicity checks per symbol.

## Latency and DQ checks (client-side)
- Compute `now - event_ts` and emit metric; alert if p99 > 500 ms.
- Validate `seq` monotonic per symbol; log anomalies.
- Track last message timestamp per symbol; alert if stale.

## Fallback path
- If TA topics unavailable, fall back to raw bars/trades or disable TA features via flag.
