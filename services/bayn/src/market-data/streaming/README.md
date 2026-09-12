# Streaming market data

The execution worker initially uses `BAYN_MARKET_DATA_MODE=shadow` with `BAYN_KAFKA_BROKERS`, `BAYN_KAFKA_USERNAME`,
`BAYN_KAFKA_PASSWORD`, and `BAYN_KAFKA_TIMESTAMP_POLICY=dorvud.producer-clock.v1`. The reviewed bootstrap deadline
is 120 seconds. SCRAM-SHA-512 uses the existing 9092 listener. The KafkaUser secret reaches Bayn through the existing
secret reflection path. The public status service and archive research commands do not start a consumer.

Shadow mode keeps archive execution and compares raw input hashes and strategy results at the same observation.
Logs distinguish different input cuts, unavailable streams, invalid decisions and matching or mismatching decisions.
A reviewed change to `BAYN_MARKET_DATA_MODE=streaming` selects streaming execution; failures then block that path.

A replacement consumer captures partition bounds and rebuilds the required 30-minute window before serving inputs.
Offsets are committed only after incorporation or explicit rejection. The projection retains 61 bar minutes, 512
quote/trade updates and 64 feature revisions per symbol, plus 256 rejections per partition. Windows that need
discarded rejection history fail verification. An observation older than retained history fails.
Reassignment discards the old projection. Connection attempts are bounded; after exhaustion, a later read can
request a fresh rebuild after a 30-second cooldown. Scope closure cancels consumption and closes the client.

Snapshots bind the consumer epoch, local receipt sequence, transport positions, raw rows and selected feature
payloads. Separate pricing snapshots are retained when execution uses a different quote cut. PostgreSQL commits
immutable references in the decision transaction. Restart verification requires the exact committed reference.
Flink failure does not disable broker reconciliation or the existing close-window recovery path.

## Retained-input verification

```sh
node dist/streaming-diagnostics-command.js --since 2026-09-11T19:00:00Z
```

This bounded probe uses the configured Bayn Kafka identity and the production consumer/reducer. It captures source
bounds, consumes retained records, commits incorporated offsets in a unique group, verifies exact feature-to-bar
matches, and closes the connection. Receipt times are the actual diagnostic times. Its output identifies retained
input joins observed now; it does not claim those features were available in a past trading session. The image
check loads this command with `--help` and runs `--codecs` to round-trip gzip, Snappy, LZ4 and Zstd from the
finished image without network access.

## Recorded decisions

From the built service directory:

```sh
node dist/streaming-replay-command.js --file decision.json
node dist/streaming-replay-command.js --decision <decision-content-hash>
```

The second form reads PostgreSQL using the existing Bayn database configuration. Both forms reproduce the saved
input cut, strategy, planner and risk evidence. They neither submit orders nor rewrite evidence. A replay receipt
does not grant authority to trade or establish actual consumer availability for unused records.

## Historical experiments

`replayHistoricalMarketArrivals` uses the same reducer with an immutable run ID, supplied arrival times and the
declared `availability-topic-partition-offset` tie-break. It consumes original raw envelopes and feature payloads
exported with their Kafka coordinates. Its output explicitly identifies simulated consumer availability. Feature
computation timestamps are never backdated. A `regeneratedFeatures` declaration binds the generation run ID and
actual recording time when an experiment assigns earlier simulated arrivals. Every historical projection is marked
as simulated and is rejected by the live snapshot boundary. A regenerated feature therefore cannot be represented as an original
historical receipt.

The existing archive economics harness remains a separate evidence mode. Feature plumbing, deterministic replay and
PAPER operation do not establish profitability.

## Delivery and verification

Deliver the Dorvud producer/archive, topic and ClickHouse table before enabling Bayn streaming execution. Use the
existing reviewed-main, immutable-image, Kargo Stage and Argo path. Verify actual raw/feature joins and recorded
decision reproduction in addition to infrastructure readiness. The protocol binds the feature definition hash,
clock allowance, bootstrap policy and exact-window freshness rule. Reverting the runtime requires a reviewed source
and protocol change through the same delivery path; retaining archived feature history is required.

Bar history retains at most four winning revisions for each of 61 minutes per symbol. As-of joins select the latest revision received by the observation time. If revision eviction removes the history needed for a cut, the projection rejects that observation.
