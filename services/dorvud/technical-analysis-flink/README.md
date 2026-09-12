# Dorvud Flink technical analysis

The TA job consumes the existing Alpaca bars, quotes, and trades. It retains the existing TA outputs and can also
publish rolling market features for Bayn. The separate market-data archive job retains raw records and feature
messages in ClickHouse. See the [streaming design](../../../docs/bayn/streaming-market-data-design.md).

## Rolling feature branch

Set `TA_MARKET_FEATURES_TOPIC=torghut.market-features.v1` to enable the branch. It requires the existing
`ARCHIVE_CORE_FEED`, `ARCHIVE_CORE_BARS_TOPIC`, `ARCHIVE_CORE_UNIVERSE_ID`, `ARCHIVE_CORE_UNIVERSE_SYMBOLS`, and
`ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH` configuration, plus `TORGHUT_TA_COMMIT` for producer provenance. It uses the TA
job's Kafka credentials. Source and state operator IDs are separate from the legacy TA branch.

`dorvud.rolling-price-30m.v1` emits first open, range high and low, last close, total volume, and exact input references
once 30 contiguous finalized minute bars exist. Prices use the same binary64 multiplication and positive half rounding
to millionths as Bayn. Volume is rounded per bar before summing as an integer. Values and offsets cross JSON as decimal
strings. Repeated records do not emit another semantic feature. A canonical correction replaces its previous input
and creates a new feature ID. State resets when the New York session date advances.

The producer uses `alpaca.regular.new-york-date.v1` source classification. Bayn remains responsible for verifying the
actual broker calendar and order window. The producer does not request another calendar feed. A feature's
`computedAtMs` records computation time, including during initial retained-data consumption; it is never backdated to
the historical bar close and does not prove historical Bayn availability.

The wire message contains `material`, its SHA-256 `featureId`, `computedAtMs`, and `producerRevision`. Material includes
identity, definition hash, exact window boundaries, 30 input references, and values. Canonical JSON sorts object keys,
retains array order, and uses compact encoding. The hash excludes computation time and producer revision so restoring
identical state produces the same semantic ID. Each raw input digest binds the source metadata and binary64 price and
volume bit patterns, including optional VWAP and trade count. The shared fixture and Bayn decoder bind both runtimes
to that encoding.

## Feature archive

Set `ARCHIVE_FEATURES_TOPIC=torghut.market-features.v1` on `MarketDataArchiveJob`. The archive consumes the published
Kafka messages with a separate consumer group and writes `signal.intraday_features_v1`. It validates definition,
content hash, source universe, window coverage, and computation availability before writing. The table retains every
semantic revision and original message with the feature topic's partition and offset. At-least-once sink retries may
repeat a transport record; readers must deduplicate by those source coordinates and reject conflicting content.

GitOps creates the topic, table, grants, and configuration. No Bayn runtime identity owns ClickHouse DDL or writes.

## Validation

Run from `services/dorvud`:

```sh
./gradlew :technical-analysis-flink:ktlintCheck :technical-analysis-flink:test :technical-analysis-flink:uberJar
```

The Kotlin tests verify gaps, corrections, duplicates, session rollover, rounding, and archival validation. The shared
fixture lives in `services/bayn/src/market-data/features/fixtures/rolling-price-v1.json`. Regenerate it deliberately
with the producing test, then verify the TypeScript decoder and inspect the resulting changes:

```sh
./gradlew :technical-analysis-flink:test --tests '*RollingMarketFeaturesTest' -PwriteMarketFeatureFixture=true
```

The definition binds a 5,000 ms cross-host clock allowance. Producer, input-ingestion, and archive clocks may differ within
that bound; original timestamps are retained. Bayn eligibility still depends on its actual local receipt and the exact
completed decision window. Invalid records increment rejection diagnostics and preserve previously accepted rolling
state, so a single rejected input cannot erase 30 minutes of usable history.
