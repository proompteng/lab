# Dorvud Flink technical analysis

The TA job consumes the existing Alpaca bars, quotes, and trades. It retains the existing TA outputs and can also
publish rolling market features for Bayn. The separate market-data archive job retains raw records and feature
messages in ClickHouse. See the [streaming design](../../../docs/bayn/streaming-market-data-design.md).

## Event-time microbars and canonical technical signals

Microbars use Kafka topic, partition, and offset to deduplicate transport redelivery. Each event-time second has its
own checkpointed bucket. The configured watermark closes the bucket; open and close follow trade time, with Kafka
coordinates breaking equal-time ties. Distinct trades at an equal price remain distinct. Records arriving after
finalization increment `microbar_late_trades_total` and emit a side output and a structured quarantine log containing
their source coordinates. Their raw Kafka/archive records remain available for investigation; no conflicting final
microbar is emitted.

Microbar and legacy TA envelopes use output version 2 for the corrected behavior. TA canonicalizes each session's bars
before updating its numerical state. Duplicate revisions are inert. Corrections rebuild affected indicator outputs
with their original event windows and current computation/ingestion time. An older session cannot contaminate the
current session. Recursive EMA/MACD/RSI state retains its original seed when the bounded calculation buffer advances.
The numerical regression test compares a full regular session against the pinned TA4J implementation.

EMA pairs require 26 bars, MACD 34, RSI 15 closes, and Bollinger bands 20 contiguous bars. A gap invalidates recursive
indicator readiness until the missing input is supplied and the canonical history is recomputed. No synthetic bars
are inserted. The legacy `vol_realized.w60s` field retains its seconds-based definition and is unavailable when its
configured interval supplies fewer than two returns. It is not relabeled as 60 one-minute returns. Legacy `vwap`
fields still describe volume-weighted closes for compatibility; they must not be interpreted as source-bar VWAP.

New keyed state is versioned separately from legacy state, while existing operator restoration IDs and sequence state
are retained. On migration, an unfinished legacy microbar lacks the event ordering/source identities required by the
new calculation and is discarded with `microbar_legacy_buckets_discarded_total`. Canonical indicator state warms up
from new inputs instead of claiming that old truncated history contains a complete recursive seed or session totals.
Subsequent checkpoints restore the complete new state. The restore tests cover open microbar buckets, duplicate
redelivery, recursive seeds, and session totals. The rolling-price feature state and contract below are unchanged.

## Rolling feature branch

Set `TA_MARKET_FEATURES_TOPIC=torghut.market-features.v1` to enable the branch. It requires the existing
`ARCHIVE_CORE_FEED`, `ARCHIVE_CORE_BARS_TOPIC`, `ARCHIVE_CORE_UNIVERSE_ID`, `ARCHIVE_CORE_UNIVERSE_SYMBOLS`, and
`ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH` configuration, plus `TORGHUT_TA_COMMIT` for producer provenance. It uses the TA
job's Kafka credentials. Source and state operator IDs are separate from the legacy TA branch.

Graph construction preserves every legacy operator's restoration ID, including generated Kafka and ClickHouse sink
writers and committers. The job executes that prepared graph so enabling features retains existing savepoint state.
The savepoint regression test checks the executable graph against legacy IDs and optional source and sink configurations.
When adding the technical-indicator source to an already deployed rolling-feature graph, restoration aliases must
target that preceding graph's generated checkpoint IDs. Applying the older pre-feature aliases afterward loses the
rolling graph's generated sink IDs. Coverage includes the deployed ClickHouse signal-writer ID, optional sources and
sinks, and Flink's generated-ID fallback for subsequent checkpoints; no state is skipped during restoration.
When enabling technical features, `TA_FEATURE_RESTORE_TOPOLOGY` must identify the savepoint being restored:
`TA_ONLY` supports a direct upgrade from the original TA job, and `ROLLING_FEATURES` supports an upgrade after the
rolling-only job completed a checkpoint. The committed deployment selects `ROLLING_FEATURES` for its existing
rolling-job savepoint. Keep the selection on subsequent restarts; current generated IDs restore new checkpoints.
An absent or unknown selection fails configuration instead of guessing which topology previously ran.

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

## Retained feature replay

The same jar provides an offline entry point that feeds retained raw bar arrivals through the production rolling
feature transition. Use it when a later Kafka bootstrap's feature ordering cannot represent historical delivery:

```sh
java -Xmx1g -cp build/libs/technical-analysis-flink-all.jar \
  ai.proompteng.dorvud.ta.flink.RetainedFeatureReplay config.json retained-bars.ndjson new-output-directory
```

The input is a bar-only extraction of Bayn arrival records (`availableAtMs` and the unchanged Kafka `record`), in
availability, partition, offset order. The configuration has schema version `dorvud.retained-feature-replay.v1`, exact
`sourceSha256` and `recordCount`, `barsTopic`, `featuresTopic`, `universeId`, canonical `symbols` and their
`universeSymbolHash`, exact `producerRevision`, and `processingDelayMs`. Sources are limited to 128 MiB of extracted
bars. The command validates and executes one immutable byte snapshot; it never reopens the input after validation.
Expanded feature messages are written and hashed incrementally. The existing 5,000 ms producer/Kafka clock-skew
allowance applies to retained arrival validation as it does in the live feature contract.

Outputs use isolated simulated partition/offset coordinates, and become available at the later of the triggering raw
arrival or window end, plus the configured delay. Raw revisions and actual `computedAtMs` are preserved. These arrivals
model a continuously running feature job; they are not evidence that historical Bayn received those features. All
symbols share the source's arrival order, and corrections publish when their raw revision becomes available. Neither
missing bars nor technical indicators are fabricated. No Kafka, ClickHouse, or broker connection is acquired.

The new output directory contains `arrivals.ndjson`, the exact `config.json`, and a terminal `receipt.json` with input
and output hashes, counts, skipped nonregular/nonfinal bars, and actual computation time. A directory without the
receipt is incomplete. Combine these feature arrivals with the unchanged raw stream and freeze a new Bayn manifest;
retain the original replay separately. This command regenerates the existing rolling family only.

## Versioned technical features

Set `TA_TECHNICAL_FEATURES_TOPIC=torghut.technical-features.v1` alongside the rolling feature topic to enable
`dorvud.technical-indicators-1m.v1`. This uses a separate retained-bar cursor inside the existing TA job and the same raw decoder. It does
not create another Flink job. A new technical source starts at the retained beginning so its full-session seed does
not depend on the older rolling source's saved head offset. Subsequent checkpoints restore both source and keyed
state normally. Bootstrap output retains actual computation time and never claims historical delivery. The archive enables the matching topic with `ARCHIVE_TECHNICAL_FEATURES_TOPIC` and
retains its exact payload and transport coordinates in `signal.intraday_features_v1`; readers select the source topic
and definition explicitly. These settings are optional and do not change the rolling-price contract or strategy.

Each technical message uses `dorvud.technical-feature.v1`, with the same identity, canonical JSON hash, actual
computation time, and raw-content digest conventions as rolling features. Its input list retains every canonical
minute observed in the current New York regular session, bounded to 390 bars. `windowStartMs` is 09:30 New York;
`windowEndMs` is the end of the latest canonical minute. The source session classification bounds these features;
Bayn still verifies the broker calendar, including early closes.

Values are signed decimal integer strings rounded to millionths, with a safe-integer bound. Each field carries
`READY`, `WARMING`, `GAP`, `SOURCE_MISSING`, or `ZERO_VOLUME`; unavailable values are null. A missing value cannot
be confused with numerical zero. The definition hash binds these calculations and units:

| Fields                           | Calculation and readiness                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| EMA12, EMA26                     | Close-price EMA, first close seed, alpha 2/(period+1), ready after 12/26 bars                                           |
| MACD, signal, histogram          | EMA12 minus EMA26; signal EMA9 seeded at zero; ready after 34 bars                                                      |
| RSI14                            | Wilder gain/loss recurrence with alpha 1/14 and zero seeds; 15 closes; a flat series is zero, matching pinned TA4J 0.16 |
| Bollinger middle/upper/lower     | 20 closes, population standard deviation, two standard deviations                                                       |
| Weighted close, 5-minute/session | Sum(close times volume) divided by volume                                                                               |
| Source VWAP, 5-minute/session    | Sum(source-bar VWAP times volume) divided by volume; unavailable if a positive-volume bar lacks VWAP                    |
| Realized volatility              | Population standard deviation of 60 log returns from 61 minute closes; ratio times one million, not annualized          |

Price fields use price millionths. RSI uses percentage-point millionths. Recursive and session calculations require
complete history from the session open. Rolling calculations can recover on a complete contiguous tail after an older
gap. Zero aggregate volume makes weighted prices unavailable. Canonical corrections recompute from the retained
session seed using the same indicator functions as TA; an older session cannot alter the current one. No bars are
synthesized. Invalid inputs preserve state and increment rejection diagnostics.

The archive checks the definition and content hash, session bounds, ordered unique input references, availability,
value domains, and readiness against input coverage. Dedicated operator/state IDs keep technical feature state
separate. The executable graph preserves both legacy TA and rolling-feature restoration IDs. A shared producer
fixture at `services/bayn/src/market-data/features/fixtures/technical-indicators-v1.json` provides the Kotlin wire format
for consumer contract validation. Publishing these data points alone does not establish strategy use or profitability.

GitOps enables both topic settings and declares the technical KafkaTopic with three partitions, three replicas, and
35-day delete retention. The existing authenticated Kafka identities and archive INSERT grant cover this path; no
credential or authorization change is introduced. Topic reconciliation precedes the image-driven Kargo rollout in
the delivery proof. Verify both Flink jobs, new checkpoints, technical-topic publication, and archival rows before
enabling the Bayn optional consumer. A recovery retains topic and checkpoint data and reverts the optional settings
through reviewed GitOps. Image delivery alone is not source-to-consumer acceptance.

## Validation

Run from `services/dorvud`:

```sh
./gradlew :technical-analysis-flink:ktlintCheck :technical-analysis-flink:test :technical-analysis-flink:uberJar
```

The Kotlin tests verify gaps, corrections, duplicates, session rollover, rounding, and archival validation. The shared
fixture lives in `services/bayn/src/market-data/features/fixtures/rolling-price-v1.json`. Regenerate it deliberately
with the producing test, then verify the TypeScript decoder and inspect the resulting changes:

```sh
./gradlew :technical-analysis-flink:test --tests '*RollingMarketFeaturesTest' --tests '*TechnicalMarketFeaturesTest' -PwriteMarketFeatureFixture=true
bunx oxfmt ../bayn/src/market-data/features/fixtures/*.json
```

The definition binds a 5,000 ms cross-host clock allowance. Producer, input-ingestion, and archive clocks may differ within
that bound; original timestamps are retained. Bayn eligibility still depends on its actual local receipt and the exact
completed decision window. Invalid records increment rejection diagnostics and preserve previously accepted rolling
state, so a single rejected input cannot erase 30 minutes of usable history.

Simulated feature delivery is monotonic within its output partition. Each output is available at the later of its own
modeled completion and the previous output availability. This preserves both Kafka offset order and arrival order
when cross-host clock skew temporarily puts one symbol's completed window ahead of another symbol's input.

Retained replay uses the same rejection-preserving rolling transition as the live producer. Malformed bar payloads
and invalid feature inputs increment `rejectedBars` in the terminal receipt and preserve accepted keyed history.
`skippedBars` counts non-final or non-regular bars separately. Source hash, coordinate, arrival-order, and recorded
availability violations still reject the export itself; they cannot be reclassified as ordinary producer rejections.
