# Streaming market data

The execution worker requires `BAYN_KAFKA_BROKERS`, `BAYN_KAFKA_USERNAME`,
`BAYN_KAFKA_PASSWORD`, and `BAYN_KAFKA_TIMESTAMP_POLICY=dorvud.producer-clock.v1`. The reviewed bootstrap deadline
is 300 seconds. SCRAM-SHA-512 uses the existing 9092 listener. The KafkaUser secret reaches Bayn through the existing
secret reflection path. The public status service and archive research commands do not start a consumer.

Trading has one market-data capability: load a verified feature and raw-data snapshot, then verify its source reference.
The production adapter consumes Kafka; backtesting supplies recorded events on its simulated clock. An unavailable
adapter blocks observations. ClickHouse remains the historical archive and does not supply an execution fallback.

The initial retained-data probe consumed 905,542 records across all 22 partitions in 223 seconds on the slower worker, with no rejections and exact feature matches for all strategy symbols and SPY. The five-minute budget bounds catch-up; normal calendar, exact-window, and quote-freshness checks still run after it.

A replacement consumer captures partition bounds and rebuilds the required 30-minute window before serving entry inputs.
Liquidation snapshots require the quote topic's complete partition cut and a fresh verified quote for each held
symbol, independently of bar/feature history catch-up. They preserve the full captured partition evidence and replay
through the same verification path. Non-quote rejections do not block liquidation; quote rejections, missing or stale
quotes, and invalidated assignments do. This does not authorize entry pricing during bootstrap or change order risk.
Offsets are committed only after incorporation or explicit rejection. The projection retains 61 bar minutes, 512
quote/trade updates and 64 feature revisions per symbol, plus 256 rejections per partition. Discarded rejection cutoffs
remain partition-specific: liquidation checks quote partitions, while entry and feature selection check all partitions.
Windows that need the applicable discarded rejection history fail verification. An observation older than retained
history fails.
Reassignment discards the old projection. One scoped supervisor owns the client. Connection attempts are bounded;
after exhaustion it retries after a 30-second cooldown without waiting for a strategy read. Reads and status checks
cannot launch a client. Scope closure cancels both consumption and scheduled reconnection, then closes the client.
The transport owns each SDK stream in the consume callback, before Node can run stream construction. It installs an
error listener immediately and destroys any stream delivered after consumer shutdown. Constructor errors invalidate
the projection and still reject iteration. Node subprocess tests cover late delivery, constructor failure, consumption
after close, and normal shutdown using the real Kafka SDK streams.
The pinned Kafka 2.11.0 package patch incrementally deserializes fetched responses into the Readable queue, stopping
at its high-water mark. A broker's response remains in flight until drained, so buffer pressure cannot trigger more
fetches for that broker. Offsets advance after the batch is delivered, including control-only batches. Node tests
exercise multiple brokers, oversized responses, duplicate offsets, control markers, interruption and decoder errors.
Kafka still returns atomic compressed record batches; this bounds queued message expansion, not the size of an
individual broker batch. The memory regression uses the real stream with generated broker responses, not a live broker.
The execution worker checks projection availability on successful mutation-capable passes, including waiting
before the first strategy window. The persisted pass reports an unavailable projection to public readiness.
This check preserves reconciliation and close recovery. A blocked current session also reports failed readiness
until its close instead of being classified as historical waiting.

Snapshots bind the consumer epoch, local receipt sequence, transport positions, raw rows and selected feature
payloads. Separate pricing snapshots are retained when execution uses a different quote cut. PostgreSQL commits
immutable references in the decision transaction. Restart verification requires the exact committed reference.
Flink failure does not disable broker reconciliation or the existing close-window recovery path. Migration 0066
adds intraday protocol v3 to the durable authority contracts while preserving v1/v2 history.

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

Historical probes may need to consume a large retained backfill whose Kafka timestamps reflect recent publication.
Use `--bootstrap-timeout-seconds 7200` with `--since` to allow two hours for that read-only bootstrap. The default
is 300 seconds, and the accepted range is 1–14400 seconds (four hours). Estimate the budget from retained record
count and observed processing rate, allowing time for bounded connection recovery. The receipt records the
selected `bootstrapTimeoutMs`.
This budget applies to the diagnostic's Kafka bootstrap and wait, with 60 additional seconds for scoped shutdown;
the trading runtime's configured 300-second deadline is unchanged. Every partition must still reach its frozen
bootstrap end offset. The command retains all decoding, identity, availability, and exact raw-bar join checks.
An expired budget is a failed probe and produces no successful receipt.

## Historical execution

The backtest command drives the same trading engine using a frozen event source and a simulated clock.
Raw events, matched feature revisions, candidate exclusions, and freshness checks use the production projection.
The source adapter declares simulated availability and preserves original event and ingestion times. Kafka
captures retain their independently recorded partition bounds and source hashes. Regenerated features retain
actual generation timestamps and explicitly modeled availability.

The backtest report includes decisions, orders, simulated fills, positions, fees, and PostgreSQL/TigerBeetle
reconciliation for every requested session. The decision-only historical experiment and archive replay commands
have been removed. See the [backtest workflow](../../../README.md#replay-and-backtesting).

## Session measurements

Each worker logs `Kafka feature incorporated` for accepted features before join-history retention can discard them.
Retries of retained semantic IDs do not create another receipt; deduplicate by epoch and feature ID when aggregating. The
`bayn.feature-availability.v1` record binds the feature ID and Kafka coordinates to its actual local receipt time,
producer computation time, and window end. `retainedAtBootstrap` compares the feature offset to its partition's captured
exclusive end, so post-cut live arrivals remain classified correctly before the readiness monitor ticks. Compute session
p50/p95/p99 from these records, grouped by epoch and symbol; exclude retained bootstrap records, retained-input diagnostics,
and regenerated historical features from live-session latency statistics. Preserve
the session's expected windows so absent arrivals remain missing coverage rather than disappearing from the denominator.

Every 30 seconds, `Kafka market projection measurements` reports the queue high-water mark and observed depth,
per-partition incorporated and sampled end offsets, raw quote/trade ages, current-window bar coverage, feature matches,
and unmatched feature revisions. Offset lag is an exact decimal string and includes Kafka control-record positions;
it is not a market-message count. A failed end-offset lookup produces null lag with allowlisted SDK and broker error
codes; raw exception messages are omitted. Missing
symbols have null event ages. These measurements describe input coverage; the existing snapshot, calendar, strategy,
and risk checks determine trading eligibility. Feature archive lag is measured separately from ClickHouse observation
times and Kafka feature identities.

## Delivery and verification

Deliver the Dorvud producer/archive, topic and ClickHouse table before enabling Bayn streaming execution. Use the
existing reviewed-main, immutable-image, Kargo Stage and Argo path. Verify actual raw/feature joins and recorded
decision reproduction in addition to infrastructure readiness. The protocol binds the feature definition hash,
clock allowance, bootstrap policy and exact-window freshness rule. Reverting the runtime requires a reviewed source
and protocol change through the same delivery path; retaining archived feature history is required.

Bar history retains at most four winning revisions for each of 61 minutes per symbol. As-of joins select the latest revision received by the observation time. If revision eviction removes the history needed for a cut, the projection rejects that observation.

## Technical indicator evidence

`BAYN_KAFKA_TECHNICAL_FEATURES_TOPIC=torghut.technical-features.v1` subscribes the same scoped consumer to Dorvud's
`dorvud.technical-feature.v1` messages. The definition is `dorvud.technical-indicators-1m.v1`. The producer publishes
EMA 12/26, MACD/signal/histogram, RSI 14, Bollinger bands 20, five-minute/session weighted close and source VWAP,
and volatility over 60 log returns. Each scalar carries its own readiness and explicit units. Bayn validates the
versioned definition, payload hash, identity, session bounds, source references, readiness and numeric domains.
It does not recalculate indicators.

An optional technical receipt joins only when it was available at the observation, ends at the exact decision-window
boundary, and its source-reference suffix matches the currently selected raw bars, including corrections and content
hashes. The producer retains complete session provenance; Bayn independently verifies the decision-window suffix,
not older raw bars outside its retained window. The full technical payload and source references are hashed into the
snapshot. Recorded live and simulated snapshots reproduce this evidence and reject changed receipts or availability.

An observed replacement supersedes an older technical receipt for the same session and window, even if its raw
correction has not arrived yet. Selection and diagnostics leave that window unavailable until the replacement
matches; earlier observations still use only the revisions available at that time.

Missing, late, mismatched or malformed technical input remains unavailable. It cannot authorize a baseline entry or
invalidate otherwise accepted raw and rolling inputs. A technical rejection invalidates older optional receipts until
a later distinct valid snapshot arrives. Optional receipt and rejection retention is bounded. The existing strategy,
thresholds, ranking, risk policy and behavior/parameter hashes remain unchanged; these indicators are retained evidence
for subsequent strategy research, not a new claimed trading edge. The original input-cut shape is retained when the
optional topic is unconfigured.

Frozen replay sources can include `universe.topics.technicalFeatures`. That topic and its retained source bytes are
bound to the run and reproduced cut. Raw, rolling and technical topics must be distinct. Rolling regeneration binds
`regeneratedFeaturesRecordedAtMs`; technical regeneration separately requires
`regeneratedTechnicalFeaturesRecordedAtMs` in the source manifest and every reproduced cut. Both preserve actual
computation time and validate it against the corresponding regeneration receipt while retaining modeled availability.
The rolling marker alone cannot admit backdated technical arrivals. Original technical records and live consumers
must pass the normal computation-to-arrival clock bound. The historical economic study
under `docs/bayn/evidence/2026-09-11-native-replay/` did not include technical indicators or modify the baseline.

Enable the consumer after the reviewed producer/topic deployment. `Kafka technical feature incorporated` logs report
feature identity, source position, computation and receipt times; they prove ingestion, while a reproduced snapshot
with matching technical receipts proves the join.

## Simulated execution inputs

`constructSimulatedSnapshot` consumes the incremental historical cursor through the same selection rules as live
streaming. Its `bayn.simulated-market-snapshot.v1` manifest records the run ID, frozen source-manifest hash, supplied
arrival policy, source positions, raw receipts, and feature payloads. Regenerated features keep their original
computation timestamps and record the separate simulated availability explicitly.

The execution document uses market-data binding v4 and requires `replay-<runId>` as its account. Decision and pricing
cuts must share the same source and arrival policy. They run the existing strategy, planner, pricing, and risk
validation. Recorded reproduction reports `recorded-simulated-decision`; live streaming and archive contracts retain
their existing versions.

The replay composition supplies `makeSimulatedMarketData` instead of live Kafka or ClickHouse capabilities.
Migration 0068 adds a separate append-only simulated-reference table. Verification accepts a cut consumed by that
service instance or an exact reference committed with a decision in the same replay database. A recreated service
must find the committed reference; another run or source manifest cannot reuse it. Live reference tables reject
simulated manifests. The service factory does not connect to a broker or provide capital authority.

This input integration is a component of the execution replay. It does not itself run a full session, submit orders,
restart the execution process, or produce an economic result.

## Production execution replay runtime

`makeReplayExecutionRuntime` assembles the production research-authority activation, cycle store, decision builder,
intent/risk persistence, execution coordinator, final-submit checks, and broker reconciliation around the simulated
market-data and broker ports. It acquires no Alpaca HTTP client or credentials. The caller supplies isolated PostgreSQL
and TigerBeetle services plus the build and strategy provenance being evaluated.

Migration 0069 adds an account-specific simulation clock. Only `replay-<sha256>` accounts can register it; the source
manifest identity is immutable and time cannot move backwards. A missing clock blocks a simulated account. Intent
transition and mutation-start risk-expiry checks use this clock for simulated accounts and PostgreSQL wall time for
all other accounts. Authority, reconciliation, and cycle-completion queries receive the same clock explicitly.

The required database acceptance test now drives a production cycle through a risk-approved intent, simulated fill,
and exact accounting in real PostgreSQL and TigerBeetle. Recreating the runtime preserves its activated generation.
The separate accounting test still checks reconnecting database clients. These fixtures do not establish full-session
replay, process-crash recovery, or profitability; those require the session runner, retained source manifests, and
closed-window economic reports.

## Full calendar-session command

```sh
BAYN_BACKTEST_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:55432/bayn_replay \
BAYN_BACKTEST_TIGERBEETLE_ADDRESS=127.0.0.1:53000 \
BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID=20912 BAYN_BACKTEST_TIGERBEETLE_LEDGER=70912 \
node dist/backtest-command.js --input session.json --arrivals source.ndjson.gz \
  --source-receipt source-receipt.json --source-receipt-sha256 "$SOURCE_RECEIPT_SHA256" --output new-run-directory
```

Run this command against separately provisioned local stores. It accepts only local PostgreSQL databases whose names
end in `_replay`/`_test` (or `replay`/`test`) and a local TigerBeetle replica. It requires an unused PostgreSQL authority
state and never clears either database. Give each attempt a distinct `replicate` in the frozen input; resetting
PostgreSQL while retaining TigerBeetle under the same run ID is not a fresh run. Database clients close with the command. Individual database and reconciliation operations retain their deadlines; the total backtest length is governed by the selected sessions.
The normal service composition does not load this command or its virtual clock.

`bayn.backtest.v1` binds consecutive calendar sessions, source manifest, unchanged source-controlled strategy
and build, opening cash, IOC latency/liquidity/slippage/fee assumptions, and production polling/reconciliation cadence.
It also retains asset metadata and its observation time. Asset eligibility captured after the session must explicitly
use `counterfactual-current-asset-eligibility`; it cannot be described as historical as-of evidence. Embedded builds
must match the input build; source invocations identify their build verification as `development-configured`.

The `bayn.backtest-source.v1` manifest requires `encoding: "ndjson-gzip"` and binds the SHA-256 of the complete compressed NDJSON file, record count, export
coverage interval, first/last arrival, partition bounds, universe, origin, delivery policy, and explicit `captured-kafka` or `alpaca-rest` transport. Each line uses
`HistoricalMarketArrivalSchema`. The reader verifies the entire file before execution, then reads bounded chunks
while retaining the production projection. It rejects duplicate/reversed Kafka coordinates, reversed availability,
records outside the frozen cuts, and changed bytes/counts. The current Torghut capture profile independently requires
three bar partitions, thirteen quote partitions, three trade partitions, and three retained feature partitions.
The offline regenerated feature stream has its own single partition. Every partition needs a cut, including empty
cuts with equal start/end offsets. Record-derived partition inventories cannot establish source completeness.
The independently pinned receipt must cover the full exchange session. The file must match its exact first/last arrivals; a quiet opening or closing interval does not fabricate missing events.
Every partition cut must also equal the independently captured offset receipt. Its separately supplied SHA-256 is
trusted configuration, outside the editable session input; replacing the receipt without that authority is rejected.
It rehashes the consumed stream before a final report. Initial and final reconciliation use the configured live
reconciliation deadline while market time remains simulated.
There is no 500,000-record or single-observation limit on this path.

The timeline advances available source records, the account-specific PostgreSQL clock, and the Effect clock together.
Broker submission advances them to its declared arrival time before reading the execution quote. Database I/O does not
consume modeled market time. The driver executes the native polling cadence from market open through the close,
including the final boundary; the source-controlled strategy still applies its own warmup and order-risk rules.
Closing equity is captured at the exact calendar close and fills receive a final reconciliation one millisecond later.
A regular-session IOC whose modeled arrival reaches or exceeds the close expires at the close without a fill; its
latency cannot advance execution beyond the closing-equity boundary.

The new output directory retains `input.json`, `passes.ndjson`, and a hashed `report.json` with broker state, closing
equity, schedule counts, durable row counts, and the production reconciliation result. Preserve the source file and
both databases alongside it. A report with missing inputs, failed passes, unresolved orders/positions or accounting
mismatches is not acceptance. The command reports profitability as `UNPROVEN`: source coverage, realistic execution
assumptions, independent sessions, and cost sensitivity still require evaluation. The existing durable integration
test proves a native intent/fill/accounting path; it does not substitute for a retained full-session result or a
full-process crash/restart test.

Each replayed IOC retains its actual modeled arrival quote, source coordinates and record hash, quote availability
and age, and the fill, cancellation or rejection reason. Price-limit cancellations include the rounded adverse price
used by the execution model. Order limits and quantities remain on the same broker order; the report binds the
latency, slippage, liquidity and fee assumptions. These receipts survive broker checkpoints. Every newly settled IOC retains its execution receipt.

Every pass also retains the production cycle result and broker state. The final report binds the pass file's SHA-256
and record count. `ENTRY_INTENTS_SETTLED_UNTIL_CLOSE` identifies a filled or partially filled entry whose immutable
attempt remains bound through the close. An exact zero-fill IOC cancellation instead completes only after a later exact
flat reconciliation. The standing mandate may then create the next distinct attempt after at least one minute, while
the entry cutoff remains open. Each attempt evaluates fresh signals across the strategy candidates. The v4 cycle
identity and unique PostgreSQL authority slot record an increasing attempt ordinal without a session-wide quota;
replay uses the same rule through the production engine. No retry reuses an intent, decision, cycle ID, or broker order.
Entry and quote-backed close limit prices include the production risk policy's bounded allowance, and the modeled arrival price must still
satisfy that limit before a fill is possible.

For captured Kafka, the required receipt uses `bayn.replay-source-capture.v1` with `capturedAt`, `origin`, `coverageStartMs`,
`coverageEndMs`, `universe`, and complete `positions` (`topic`, `partition`, `startOffset`, `endOffsetExclusive`).
Capture the raw cuts with Kafka ListOffsets at both requested boundaries, resolving a missing timestamp match to the
captured high-water mark. Obtain regenerated-feature extents from the independently retained producer receipt.
Freeze the receipt and its byte SHA-256 at capture time; do not derive them from whichever records the replay export
happens to contain. Supply that trusted hash through `--source-receipt-sha256`. The command checks both receipt bytes and
every manifest cut before touching a database, copies the receipt to its output, and binds its hash into the run ID
and final report. This establishes completeness relative to the pinned capture authority; it does not authenticate
market prices or calibrate the data feed.

REST exports use `bayn.alpaca-rest-replay-receipt.v2`, which binds the dataset ID, acquired symbols, unacquired strategy
candidates, raw chunk hashes, Dorvud feature receipt, final source hash, modeled coordinate policy, and `NOT_OBSERVED`
original stream availability. The declared universe is a strategy contract, not a claim that every candidate was
acquired. The receipt must list the exact complement of its acquired symbols; unacquired candidates remain excluded.
Version 2 normalization includes raw delivery delay after bar finalization. Its virtual
streams have one partition each. The same source validator and projection consume both transports. See the
[historical data workflow](../../../README.md#historical-data-workflow) for acquisition, ClickHouse publication,
verified restoration, and feature production outside the deployed service.

## Process recovery acceptance

The replay checkpoint store commits the complete broker payload and its content hash together in PostgreSQL
migration 0070, using a separate scoped connection pool. A killed coordinator transaction cannot roll back that
simulated broker commit. The broker's settlement callback persists the calculated terminal IOC state before that
state becomes visible to broker readers or a submit response can reach the coordinator. A failed or uncertain
commit blocks further state reads and mutations until restoration. Recovery reads the latest source-bound payload from PostgreSQL, verifies its receipt and
configuration, and advances from the retained broker timestamp before reconciling. A broker commit may be ahead of
the rolled-back execution clock; a checkpoint behind the committed execution clock is stale and cannot recover it.

The process-death test kills the worker inside settlement after its database commit and before either in-memory
publication or the coordinator response. It
removes the exported checkpoint file before the kill and recovers from PostgreSQL in a new PID, proving one intent,
one fill, one accounting transaction, and exact reconciliation with real TigerBeetle. Export files are not recovery
authority. The full-session command still requires a fresh database; it does not expose a command-line resume mode.

## Bar publication timing

New live and simulated cuts bind `barPublicationPolicy: timely-equivalent-revision.v1`. Original minute bars allow
60 seconds to finalize plus 10 seconds for publication; `updatedBars` allow the provider's following half-minute
correction, or 90 seconds plus 10 seconds. Both include the existing five-second clock allowance. This follows
[Alpaca's updated-bar timing](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data). These limits are
independent of `maximumQuoteAgeMs`; executable quote freshness is unchanged.

The latest bar revision still has to match the exact rolling feature's coordinates and content hash. If consecutive
revisions have identical market values and identity, the projection retains the first publication as a timing witness,
including after normal revision-history eviction. The snapshot binds its row, receipt, availability and source cut.
A changed price, volume, VWAP or trade count starts a new publication history and must meet its own timing limit.
Reconstruction verifies both deliveries and rejects altered, future or out-of-cut witnesses. The additional retained
witness is bounded to one per bar revision. Cuts without the policy marker retain the legacy quote-linked timing
rule and omit publication witnesses; archived snapshot contracts are unchanged.

## Replay close and coverage acceptance

The broker also accepts production close-only `MARKET/DAY` sells, including fractional quantities when the captured
account configuration enables fractional trading. It uses the fresh
arrival bid, adverse slippage, configured liquidity fraction and the existing fee model. The observed displayed
liquidity must cover the entire close. Missing, stale, future or insufficient liquidity fails the simulation and
prevents session acceptance; this model does not estimate how a DAY remainder would fill later. No partial fill or
IOC cancellation is invented for that unsupported case. Market orders have no limit price, and checkpoint restoration
reconstructs their request hash, fills, fees and remaining quantity.

Session schedules retain readiness counts and `unavailableDecisionPassCount`. Missing, stale or incomplete required
decision evidence, archive-watermark waits and unexplained decision-pending states produce `missing-decision-data`
and `INCOMPLETE`, even with zero failed passes and exact flat accounting. Lookback warmup, valid no-candidate signals
and expected order/reconciliation lifecycle waits do not count as missing decision evidence. These counters measure
scheduled observations; they do not establish profitability or replace a complete retained source capture.
