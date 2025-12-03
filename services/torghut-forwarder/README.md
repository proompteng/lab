# Torghut Forwarder

Python 3.11+ service that subscribes to Alpaca market WebSocket feeds and forwards trades, quotes, and 1m bars to Kafka with a consistent envelope, deduplication, and Prometheus metrics.

## Quick start

```bash
cd services/torghut-forwarder
# Set env vars (see below) then run
uv run torghut_forwarder/app.py
```

### Required environment

| Variable | Description |
| --- | --- |
| `ALPACA_API_KEY_ID` / `ALPACA_SECRET_KEY` | Alpaca credentials (sealed in `torghut-alpaca`). |
| `ALPACA_FEED` | `sip` or `iex` (default `sip`). |
| `ALPACA_SYMBOLS` | Comma-delimited symbols to subscribe (default `SPY,QQQ`). |
| `KAFKA_BOOTSTRAP_SERVERS` | Kafka bootstrap host (default `kafka-kafka-bootstrap.kafka:9092`). |
| `KAFKA_USERNAME` / `KAFKA_PASSWORD` | SCRAM user (reflected secret `torghut-forwarder`). |
| `TOPIC_TRADES` / `TOPIC_QUOTES` / `TOPIC_BARS` / `TOPIC_STATUS` | Topic names. |
| `PRODUCER_LINGER_MS` | Kafka producer linger (default `50`). |
| `DEDUP_TTL_SECONDS` | Dedup cache TTL in seconds (default `900`). |
| `METRICS_PORT` | HTTP port for `/healthz` and `/metrics` (default `8080`). |

Other tunables exist in `torghut_forwarder/config.py`.

## Envelope schema

Each Kafka message contains:

```json
{
  "ingest_ts": "UTC ISO timestamp when forwarded",
  "event_ts": "Alpaca event timestamp",
  "channel": "trades | quotes | bars | trade_updates | status",
  "symbol": "ticker",
  "seq": 123,
  "payload": { "original Alpaca payload" },
  "is_final": false,
  "source": "alpaca",
  "key": "dedup key"
}
```

Topic details and retention are documented in `../../docs/torghut-forwarder-topics.md`.

## Testing

```bash
cd services/torghut-forwarder
uv run pytest
```

## Building & deploying

- Build/push image: `bun run build:torghut-forwarder`
- Build + apply kustomize (torghut namespace): `bun run deploy:torghut-forwarder`

## Metrics & health

- `/healthz`: returns 200 once Kafka producer and subscriptions are ready.
- `/metrics`: Prometheus exposition including counters for received/forwarded events, dedup drops, publish latency, and reconnects.

## Smoke test

`scripts/torghut-forwarder-smoke.sh` port-forwards Kafka, runs the forwarder locally with a small symbol set, and consumes from the `alpaca.*` topics to verify envelopes.
