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

## Latest quote and trade observations

The producer can supply missing IEX quotes and trades with Alpaca's bulk
[latest-quotes](https://docs.alpaca.markets/us/reference/stocklatestquotes-1) and
[latest-trades](https://docs.alpaca.markets/us/reference/stocklatesttrades-1) endpoints. Enable it with
`ALPACA_LATEST_SYMBOLS`, listing static equity symbols that have neither quote nor trade WebSocket subscriptions.
The configuration requires one shard and the existing IEX feed. An absent symbol list disables polling.

`ALPACA_LATEST_POLL_INTERVAL_MS` defaults to 2,000 ms and accepts values from 2,000 to 60,000 ms. Each pass requests both
channels; the next pass starts after the current pass finishes and the interval elapses. `ALPACA_LATEST_MAX_AGE_MS`
defaults to 10,000 ms and accepts values from 1,000 to 10,000 ms. A five-second deadline bounds each channel's request
and Kafka acknowledgements, including interruption of a blocking Kafka send. The shared REST client waits at least
500 ms after each HTTP request completes before starting another, including every historical recovery page, and
applies provider retry and reset headers. A rate limit without usable headers delays requests for 60 seconds. Each HTTP
request has a ten-second deadline; expiration is a retryable failure, while caller cancellation still propagates.
These are per-process limits; production uses one replica
with a Recreate rollout.

Emitted version-2 envelopes use `source=rest_latest`. They preserve provider event timestamps, numeric values,
exchanges, conditions and trade IDs, and record actual HTTP arrival time in `ingestTs`. Alpaca's latest-trade endpoint
excludes odd lots and other trades that do not update bar prices. Repeated polling also omits intermediate events.
These records are point samples. Both technical-analysis trade-volume aggregators exclude them before creating
microbars. Provider bars continue to supply Bayn's volume and technical features.

The poller validates each response before publication. Missing symbols produce no observation; stale or future events
are omitted; malformed responses fail that channel. It retains deduplication state only after Kafka acknowledges the
record. Failed publication remains retryable, acknowledged observations cannot regress in event time, and shutdown
cancels the polling task. Restarts may republish an equivalent sample with new transport coordinates.

`/readyz` reports `latest_rest_observations` separately from WebSocket gates. It includes configured symbols,
acknowledged provider event times, unavailable symbols and channel errors. An old acknowledged value becomes
unavailable when its provider age exceeds the configured bound, even when HTTP remains successful. REST publication
does not satisfy WebSocket subscription or event-freshness gates. Bayn still applies its own snapshot and Jev pricing
checks. The Kafka record retains sample provenance; Bayn's snapshot binds normalized values and source coordinates.
ClickHouse quote and trade archive rows retain normalized values and Kafka coordinates, but omit the `source`
discriminator and complete provider payload. Preserve the original Kafka envelopes when acquisition provenance is
required beyond Kafka's configured retention period.

Roll out the TA sample exclusions and the producer implementation first. Verify the deployed TA image contains the
exclusion before adding `ALPACA_LATEST_SYMBOLS` through GitOps. The intended missing set is
`AMD,AVGO,COHR,CRDO,LITE,MRVL,MU,SNDK,WDC`; keep the existing 16 bar and seven quote/trade WebSocket subscriptions.
Activation requires regular-session proof that actual provider events for these symbols reach Bayn and change its
candidate coverage. Access checks and readiness alone cannot establish this. Existing historical captures retain their
gaps, and completing the input stream does not establish a profitable strategy.

Disabling polling does not remove retained sampled records. Keep compatible volume exclusions during rollback, or
verify that restored offsets cannot replay sampled records into an older volume consumer.

`fixtures/alpaca-latest-v1.json` is a shared provider-to-envelope fixture checked by the real producer publication path
and Bayn's immutable snapshot/replay tests. Run producer and consumer checks from this directory:

```sh
./gradlew :platform:test :websockets:test :technical-analysis:test :technical-analysis-flink:test
./gradlew :platform:ktlintCheck :websockets:ktlintCheck :technical-analysis:ktlintCheck :technical-analysis-flink:ktlintCheck
```

See [the Flink guide](technical-analysis-flink/README.md) for contracts, state migration, and validation, and the
[Bayn streaming design](../../docs/bayn/streaming-market-data-design.md) for the consumer and replay architecture.

Run the producer checks from this directory:

```sh
./gradlew :technical-analysis-flink:ktlintCheck :technical-analysis-flink:test :technical-analysis-flink:uberJar
```

Normal deployment uses the repository's reviewed main, image publication, Kargo promotion, and Argo reconciliation.
Checkpoint compatibility and actual source-to-consumer behavior are separate acceptance checks.

Local WS dev: copy `websockets/.env.local.example` to `.env.local`, fill Alpaca sandbox creds, and run `./gradlew :websockets:run` to stream into a local Kafka; `.env`/`.env.local` are auto-loaded (system env still wins). To get local infra only, run `docker compose -f websockets/docker-compose.local.yml up --build` for Kafka + UI, then start the forwarder separately with your env loaded; use symbol `FAKEPACA` for quick smoke.
