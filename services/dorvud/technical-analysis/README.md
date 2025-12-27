# Technical Analysis Service (Torghut)

Legacy Ktor service that consumes Alpaca-derived Kafka topics, aggregates 1‑second micro-bars, computes TA4J indicators, and publishes `ta.bars.1s.v1` + `ta.signals.v1` envelopes. Production now runs as a Flink job under `services/dorvud/technical-analysis-flink` with the corresponding `FlinkDeployment` at `argocd/applications/torghut/ta/flinkdeployment.yaml`. This module remains for local testing and as a reference for the Flink port.

## Running locally

```bash
cd services/dorvud
./gradlew :technical-analysis:shadowJar
java -jar technical-analysis/build/libs/technical-analysis-all.jar
```

Required configuration (env vars or Typesafe `application.conf`):

- `TA_KAFKA_BOOTSTRAP` (e.g., `localhost:9092`)
- `TA_TRADES_TOPIC`, `TA_QUOTES_TOPIC` (optional), `TA_BARS1M_TOPIC` (optional)
- `TA_MICROBARS_TOPIC` (`torghut.ta.bars.1s.v1`)
- `TA_SIGNALS_TOPIC` (`torghut.ta.signals.v1`)
- `TA_GROUP_ID`, `TA_CLIENT_ID`
- Optional: `TA_KAFKA_SECURITY`, `TA_KAFKA_SASL_MECH`, `TA_KAFKA_USERNAME`, `TA_KAFKA_PASSWORD`
- HTTP: `TA_HTTP_HOST`, `TA_HTTP_PORT`

## Endpoints

- `GET /healthz` — liveness
- `GET /metrics` — Prometheus scrape (Micrometer registry)

## Topics & schema

- Micro-bars schema: `docs/torghut/schemas/ta-bars-1s.avsc`
- Signals schema: `docs/torghut/schemas/ta-signals.avsc`

Produced Kafka records follow the shared envelope: `ingest_ts`, `event_ts`, `symbol`, `seq`, `window`, `payload`, `version`, with idempotent producers (`acks=all`, `compression=lz4`, `enable.idempotence=true`). Payloads are Avro binary (schemas in `src/main/resources/schemas`), and consumers use `isolation.level=read_committed`.

## Validation

- `./gradlew :technical-analysis:test`
- `./gradlew :technical-analysis:integrationTest` (requires Docker/Testcontainers)
- `./gradlew :technical-analysis:shadowJar`

Latency target: ≤500 ms p99 from trade event to signal; aggregation and indicator computation are kept lightweight and instrumented with Micrometer timers and counters.
