# Dorvud market data

Dorvud ingests market data, calculates technical signals, and archives source records and derived features.

- `websockets`: Alpaca WebSocket ingestion and Kafka publication, including source identity and bar revisions.
- `technical-analysis-flink`: the Flink technical-analysis job and the separate market-data archive job. The TA job
  consumes trades, quotes, and minute bars, produces microbars and technical signals, and publishes versioned rolling
  features for Bayn. The archive job writes raw records and published features to ClickHouse.
- `technical-analysis`: shared payloads, serializers, and calculation utilities used by the Flink job.
- `platform`: shared envelopes, timestamps, and Kafka configuration.
- `hyperliquid-feed`: the separate Hyperliquid ingestion module.
- `flink-integration`: integration support.

Bayn consumes raw Kafka records and the feature topic. It owns strategy selection, risk, broker orders, accounting,
and reconciliation. Dorvud does not grant trading authority or establish strategy profitability.

With `ENABLE_BARS_BACKFILL=true`, the WebSocket forwarder also reconciles provider bars every minute. This task remains
active after the market closes and while the WebSocket reconnects, refreshing requested symbols on each pass.
It first checks `BARS_BACKFILL_LOOKBACK_HOURS`,
then uses five-minute overlapping windows. It repeats the full lookback hourly and when the requested symbols change.
Every request page uses the same completed-minute cutoff. Each pass has a 60-second deadline.

Recovery publishes only provider-supplied completed bars that this process has not acknowledged in Kafka. A failed
request, malformed page or failed acknowledgement leaves the scan incomplete for retry. It does not invent bars for
intervals the provider omits. Recovered envelopes keep `source=rest` and their actual recovery time, so they cannot
establish earlier live availability. Restarts repeat the bounded scan and may republish equivalent bars; consumers
retain their existing revision and duplicate handling. Recovery does not satisfy live WebSocket freshness gates.

See [the Flink guide](technical-analysis-flink/README.md) for contracts, state migration, and validation, and the
[Bayn streaming design](../../docs/bayn/streaming-market-data-design.md) for the consumer and replay architecture.

Run the producer checks from this directory:

```sh
./gradlew :technical-analysis-flink:ktlintCheck :technical-analysis-flink:test :technical-analysis-flink:uberJar
```

Normal deployment uses the repository's reviewed main, image publication, Kargo promotion, and Argo reconciliation.
Checkpoint compatibility and actual source-to-consumer behavior are separate acceptance checks.

Local WS dev: copy `websockets/.env.local.example` to `.env.local`, fill Alpaca sandbox creds, and run `./gradlew :websockets:run` to stream into a local Kafka; `.env`/`.env.local` are auto-loaded (system env still wins). To get local infra only, run `docker compose -f websockets/docker-compose.local.yml up --build` for Kafka + UI, then start the forwarder separately with your env loaded; use symbol `FAKEPACA` for quick smoke.
