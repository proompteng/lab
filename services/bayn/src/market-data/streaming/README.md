# Streaming market data

The execution worker requires `BAYN_KAFKA_BROKERS`, `BAYN_KAFKA_USERNAME`,
`BAYN_KAFKA_PASSWORD`, and `BAYN_KAFKA_TIMESTAMP_POLICY=dorvud.producer-clock.v1`. The reviewed bootstrap deadline
is 300 seconds. SCRAM-SHA-512 uses the existing 9092 listener. The KafkaUser secret reaches Bayn through the existing
secret reflection path. The public status service and archive research commands do not start a consumer.

Trading has one market-data capability: load a verified feature and raw-data snapshot, then verify its source reference.
The production adapter consumes Kafka; backtesting supplies recorded events on its simulated clock. An unavailable
adapter blocks observations. ClickHouse remains the historical archive and does not supply an execution fallback.

The initial retained-data probe consumed 905,542 records across all 22 partitions in 223 seconds on the slower worker, with no rejections and exact feature matches for all strategy symbols and SPY. The five-minute budget bounds catch-up; normal calendar, exact-window, and quote-freshness checks still run after it.

A replacement consumer captures partition bounds and rebuilds actual retained history before serving entry inputs.
The current strategy uses at most 30 minutes of context and requires the latest completed minute, a matching native
feature and fresh quotes. It has no 30-bar or contiguous-history admission gate. Equities can first evaluate one
minute and two seconds after the broker open; crypto uses its current completed history continuously. Missing older
minutes remain visible gaps. Historical backfills keep their real ingestion and replacement-consumer receipt times.
Premarket, prior-session, non-final, future and fabricated bars cannot substitute for current session evidence.
Liquidation snapshots require the quote topic's complete partition cut and a fresh verified quote for each held
symbol, independently of bar/feature history catch-up. They preserve the full captured partition evidence and replay
through the same verification path. Non-quote rejections do not block liquidation; quote rejections, missing or stale
quotes, and invalidated assignments do. This does not authorize entry pricing during bootstrap or change order risk.
Transport positions advance only after incorporation or explicit rejection, including drained control offsets.
Each consumer epoch uses a new group and explicit bootstrap offsets. It never resumes from Kafka-committed offsets,
so it does not write OffsetCommit requests. An offset-coordinator write failure cannot discard a usable in-memory
projection. Assignment, heartbeat and fetch failures still invalidate the epoch and require reconstruction.
Durable decision snapshots retain their source cuts and PostgreSQL references independently of the ephemeral consumer.

The native worker also retains the original consumer deliveries in PostgreSQL. `native_arrival_epochs` binds the
embedded build, both market sources and the actual bootstrap bounds. `native_arrival_chunks` holds hash-linked gzip
chunks of exact Kafka value bytes, transport timestamps, local availability times, consumer and projection sequences,
and reducer dispositions. Repeated deliveries, rejected inputs, tombstones and invalidated assignments retain their
own receipts. The global consumer sequence spans equities and crypto; filtering out another market cannot claim a
complete original prefix.

Chunk appends and replay reads use the `(capture_id, ordinal)` primary key. Migration 0142 removes the unused global
content-hash unique index, which caused random reads across unrelated captures on every append. Header and compressed
byte hash checks, ordered-prefix guards and immutable-row triggers remain enforced. The header hash includes the capture
ID and ordinal, so a repeated valid header is already rejected by the primary key and prefix guard.

The capture owns one database connection outside the trading writer fence. It compresses batches at 256 KiB, bounds
each uncompressed chunk to 4 MiB and queued compressed bytes to 64 MiB, and flushes a short tail every second.
Compression batches yield to Node I/O; the writer groups up to 8 MiB or 256 chunks into one atomic database append.
Within that transaction, PostgreSQL inserts at most 1 MiB or 16 chunks per statement. This bounds each SQL statement
while sharing one synchronous durable commit across the append. A failed statement rolls back the whole append.
An individual valid chunk above the SQL byte target is written whole under the existing chunk and queue bounds.
Database writes run in a scoped background fiber. A full compressed queue backpressures the consumer until the
writer acknowledges space. The ticker and consumer share one buffer permit, so a waiting flush cannot reorder
chunks or grow the open buffer. Existing quote freshness and bootstrap deadlines still apply while consumption waits.
A failed write, invalid delivery or individually oversized chunk permanently marks the epoch incomplete; the
warning/error retains its capture ID and the periodic projection log reports its observed and acknowledged
delivery counts. Native capture failures also use the error-only GlitchTip boundary; collector failures do not
interrupt journal finalization. Shutdown drains queued chunks before flushing its remaining observed tail, retries an interrupted
chunk by exact content and records `native_arrival_ends` only after
the stored prefix is confirmed. An unsealed or incomplete epoch cannot assert complete capture coverage.
`readNativeArrivalEpoch` and bounded `readNativeArrivalChunks` verify stored identities and original bytes for research.
These native records still require interval, source-cut and strategy qualification. They do not recover missing older
study sessions or authorize an entry, and the current single-universe backtest manifest cannot label a filtered mixed
market epoch as a complete original capture.

The projection retains 61 bar minutes, 512
quote/trade updates and 64 feature revisions per symbol, plus 256 rejections per partition. Discarded rejection cutoffs
remain partition-specific: liquidation checks quote partitions, while entry and feature selection check all partitions.
Windows that need the applicable discarded rejection history fail verification. Liquidation checks quote retention
for its requested held symbols independently of other symbols and bar/trade history; an observation older than a
required symbol's retained quote history fails.
Reassignment discards the old projection. One scoped supervisor owns the client. Connection attempts are bounded;
after exhaustion it retries after a 30-second cooldown without waiting for a strategy read. Reads and status checks
cannot launch a client. Scope closure cancels both consumption and scheduled reconnection, then closes the client.
Invalidation belongs to its consumer epoch. A delayed callback from a closed consumer cannot invalidate its replacement;
an invalidation without a cause still revokes reads and triggers the same bounded rebuild. Readiness requires both
completed bootstrap and no retained failure. Measurements report bootstrap completion and read availability separately,
and failed worker checks retain the epoch and bounded failure reason without transport credentials or raw exception data.
The transport owns each SDK stream in the consume callback, before Node can run stream construction. It installs an
error listener immediately and destroys any stream delivered after consumer shutdown. Constructor errors invalidate
the projection and still reject iteration. Node subprocess tests cover late delivery, constructor failure, consumption
after close, and normal shutdown using the real Kafka SDK streams.
The pinned Kafka 2.12.1 package patch incrementally deserializes fetched responses into the Readable queue, stopping
at its high-water mark. A broker's response remains in flight until drained, so buffer pressure cannot trigger more
fetches for that broker. Offsets advance after the batch is delivered, including control-only batches. Node tests
exercise multiple brokers, oversized responses, duplicate offsets, control markers, interruption and decoder errors.
The bounded response fix is submitted as [upstream PR #426](https://github.com/platformatic/kafka/pull/426).
Remove the patch when a published release contains both changes and passes the retained Node regressions.
The patch also backports upstream [offset-refresh invalidation](https://github.com/platformatic/kafka/pull/422).
Responses suspended by backpressure retain their fetch epoch; a rebalance discards their undelivered records.
Delayed deserialization hooks release their broker and resume fetching from the restored offsets.
Kafka still returns atomic compressed record batches; this bounds queued message expansion, not the size of an
individual broker batch. The memory regression uses the real stream with generated broker responses, not a live broker.
The execution worker checks projection availability on successful mutation-capable passes, including waiting
before the first strategy window. The persisted pass reports an unavailable projection to public readiness.
This check preserves reconciliation and close recovery. A blocked current session also reports failed readiness
until its close instead of being classified as historical waiting.

Snapshots bind the consumer epoch, local receipt sequence, transport positions, raw rows and selected feature
payloads. Jev's `quote-window-trade.v1` candidate policy retains matched rolling and technical feature receipts even
when raw evidence excludes their candidate. The exclusion still prevents a signal request. A missing receipt in an
older cut may reflect that older filtering contract, so it cannot prove that the worker never received the feature.
Separate pricing snapshots are retained when execution uses a different quote cut. PostgreSQL commits
immutable references in the decision transaction. Restart verification requires the exact committed reference.
Flink failure does not disable broker reconciliation or the existing close-window recovery path. Migration 0066
adds intraday protocol v3 to the durable authority contracts while preserving v1/v2 history.

## Retained-input verification

```sh
node dist/streaming-diagnostics-command.js --query query.json
```

This bounded probe uses the configured Bayn Kafka identity and the production consumer/reducer. It captures source
bounds, consumes retained records at explicit offsets in a unique group without committing offsets, verifies exact feature-to-bar
matches, and closes the connection. The query is an exact `IntradaySnapshotQuery` JSON object with calendar, universe, window and observation time.
The receipt evaluates eligibility with `selectStreamingInputs`, reports exact missing minute timestamps, quote ages
and source coordinates, and retains every excluded candidate even when no candidate can trade. Late arrivals
remain unavailable at the requested observation. A fresh diagnostic consumer cannot recover original historical
arrival times; use retained original capture evidence for historical availability claims. The image
check loads this command with `--help` and runs `--codecs` to round-trip gzip, Snappy, LZ4 and Zstd from the
finished image without network access.

Historical probes may need to consume a large retained backfill whose Kafka timestamps reflect recent publication.
Use `--bootstrap-timeout-seconds 7200` with `--query` to allow two hours for that read-only bootstrap. The default
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

Native execution provides telemetry while acquiring its worker resources, so Kafka bootstrap, supervision and
measurement fibers inherit the JSON logger and trace exporter. Retained projection measurements are one JSON line
per sample rather than multiline console fragments.

`Streaming market snapshot rejected` retains `bayn.market-snapshot-failure.v1` diagnostics for a rejected observation:
the query window and observation time, query-bound symbol and topic, exact millisecond or nanosecond event and
ingestion times, and the publication delay and governing bound when available. The allowlist excludes raw payloads,
exception messages, arbitrary failure facts and credentials. Missing fields remain unknown. These warnings preserve
the original typed failure and trading eligibility; late benchmark bars continue to block the observation.
When a required rolling feature is unavailable, the same warning retains its definition identity and exact query
window, together with expected and observed minute-bar counts and the ordered missing minute timestamps. This coverage
is selected from the rejected observation's actual consumer cut, including its local arrival-time bound; it is not a
later periodic coverage sample. A complete bar window with no matching observed feature reports an empty missing list.
Only this rejection branch computes the missing list, which the validated query bounds to at most 30 minutes. No
additional feed, archive, database or broker request is made, and these diagnostics do not supply a replacement bar.
Coverage is computed at the live logging boundary; decision failure facts and frozen replay report identities retain
their original contents.

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
and unmatched feature revisions. `consumerSequence` counts records delivered to the incorporation owner, including
ignored and rejected records; `sequence` counts unique incorporated coordinates. `consumerKnownRawBytes` sums exact
Kafka value byte lengths before UTF-8 decoding, excluding keys, headers, compression and protocol overhead.
`consumerUnknownRawByteLengthRecords` counts delivered non-tombstone records without a valid length; their sizes
remain unknown. Tombstones contribute zero value bytes. These cumulative counters reset with each consumer epoch.
Compute interval rates from counter differences within the same epoch and the actual `observedAtMs` difference.
Thirty-second samples do not prove peak rates, continuity or original-session capture coverage. Payload lengths
remain available with capture disabled; hashing and raw-byte retention run only when requested by the capture observer.

The same periodic log includes `arrivalEnvelope` (`bayn.kafka-arrival-envelope.v1`). It reuses each record's existing
incorporation-boundary millisecond timestamp and exact raw value length, keeping four fixed scalar accumulators for
1, 10, 100 and 1000 ms bins. No payload, per-record log, additional clock sample or storage operation is added.
Within the measured epoch, `maximumAlignedWindowRecords` is a lower bound on the largest count in any window of
that width; `maximumWindowRecordsUpperBound` is the conservative upper bound from two adjacent aligned bins. The
two values bracket the exact rolling maximum; the upper bound can overcount a boundary-spanning window. Known-byte
lower bounds and complete raw-byte upper bounds follow the same rule. One unknown non-tombstone length makes every
raw-byte upper bound null for that epoch. Tombstones count as one record and zero value bytes.
`Kafka market projection arrival measurements finalized` emits the final measured prefix once when the consumer
scope closes, including failed epochs that ended before their first periodic report. Finalization of this diagnostic
does not assert successful consumer closure or complete source coverage.

Clock regression, an invalid clock or unsafe counter arithmetic permanently invalidates the envelope and makes its
upper bounds null, retaining only the measured prefix. The observer never changes projection or trading behavior.
It resets with the consumer epoch, includes bootstrap and ignored/rejected records reaching the timestamp boundary,
and does not sample records discarded before that boundary after invalidation. An empty epoch is no workload
measurement. These observed bounds exclude keys, headers, framing, SQL metadata, replication and runtime memory;
they neither predict future arrivals nor prove continuity, capture capacity or complete session coverage. Correlate
them with same-operation object/SQL phase timings before choosing a bounded capacity workload.

Offset lag is an exact decimal string and includes Kafka control-record positions;
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
The selected market source owns the optional topic. Sharing a consumer with equities does not attach their technical
topic to a crypto snapshot or its bootstrap evidence.

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
streaming. Its `bayn.simulated-market-snapshot.v2` manifest records the run ID, frozen source-manifest hash, supplied
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

## Continuous replay command

Build the offline commands from the repository root with
`bun run --filter @proompteng/bayn build:research`, then run:

```sh
BAYN_BACKTEST_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:55432/bayn_replay \
BAYN_BACKTEST_TIGERBEETLE_ADDRESS=127.0.0.1:53000 \
BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID=20912 BAYN_BACKTEST_TIGERBEETLE_LEDGER=70912 \
bun run --filter @proompteng/bayn backtest --input session.json --arrivals source.ndjson.gz \
  --source-receipt source-receipt.json --source-receipt-sha256 "$SOURCE_RECEIPT_SHA256" --output new-run-directory
```

Run this command against separately provisioned local stores. It accepts only local PostgreSQL databases whose names
end in `_replay`/`_test` (or `replay`/`test`) and a local TigerBeetle replica. It requires an unused PostgreSQL authority
state and never clears either database. Give each attempt a distinct `replicate` in the frozen input; resetting
PostgreSQL while retaining TigerBeetle under the same run ID is not a fresh run. Database clients close with the command. Individual database and reconciliation operations retain their deadlines; the total backtest length is governed by the selected sessions.
The normal service composition does not load this command or its virtual clock.

`bayn.backtest.v5` binds one explicit UTC interval, the unchanged source-controlled strategy and build, opening cash,
broker assets, execution assumptions and controller cadence. The source must cover the complete interval. UTC reporting
windows are contiguous, including weekends. The retained Alpaca calendar still controls equities, with a successor
session after the interval. Crypto remains continuous through the same engine and shared account.

`bayn.backtest-source.v2` binds a complete gzip NDJSON file, its hash and record count, coverage and availability bounds,
partition cuts, and a nonempty `marketSources` array. Each source contains its universe identity, symbols and topics.
Sources cannot overlap symbols, universe identities or topics. The native epoch and exported source preserve both
markets in their global consumer sequence. Filtering another market cannot claim the original prefix.

The reader verifies the complete file before execution, then reads bounded chunks into one production projection.
Each delivery selects its source by topic. Original v2 arrivals retain exact value bytes, transport timestamps, local
availability, consumer and reducer sequences, disposition and duplicate delivery. The cursor reproduces each recorded
disposition. Receipt-only v1 arrivals, mixed capture epochs, missing delivery sequences, changed bytes and reversed
availability fail verification. Legacy source and simulated-cut contracts cannot create current replay evidence.
Tombstones and invalidated assignments remain retained for diagnostics. A canonical replay rejects an export containing
either termination marker before execution. A separately pinned earlier prefix is required to study an unaffected interval.

Simulation snapshots use `bayn.simulated-market-snapshot.v2`, `bayn.simulated-input-cut.v2` and
`bayn.simulated-snapshot-reference.v2`. The full source inventory is retained in each cut; input selection uses the
query's exact universe. Migration 120 preserves existing immutable simulation rows and permits only current inserts.

A separately pinned receipt binds every declared market and cut. Captured Kafka uses `bayn.replay-source-capture.v2`;
original capture uses `bayn.original-capture-replay-receipt.v2` and its original delivery provenance. The trusted receipt
hash is supplied separately from the editable input through `--source-receipt-sha256`. File validation repeats after
consumption, and the receipt hash remains part of the run identity and report.

Archive reconstruction uses `bayn.archive-reconstruction-receipt.v2`. It retains original query and response hashes,
source coordinates and explicit `NOT_OBSERVED` original availability. Partitions without retained records remain
`archiveUnobservedPartitions`; no empty Kafka offsets are invented. REST uses `bayn.alpaca-rest-replay-receipt.v3`,
with the dataset, raw chunk and feature receipt hashes, acquired symbols and their exact unacquired complement.
Those transports retain their modeled availability and cannot qualify as original native captures. See the
[historical data workflow](../../../README.md#historical-data-workflow) for acquisition and feature production.

Captures and reconstructions still validate their complete declared topology. Retained equities use three bar,
thirteen quote and three trade partitions, plus three feature partitions. A regenerated feature stream has one
partition. Native crypto uses one three-partition raw topic for bars, quotes and trades, and a separate three-partition
feature topic. Captured empty cuts require independent offset evidence; a record-derived inventory cannot prove a log empty.

The timeline advances the source, database clock and Effect clock together. Broker submission advances to its modeled
arrival before selecting a quote. The same LIMIT, cancellation, partial-fill, fee, recovery and accounting rules apply
across the interval. Missing decisions, stale valuation, unresolved costs and unclosed exposure remain incomplete
results. Successful source reproduction does not establish predictive edge, actual PAPER fills or profitability.

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

Live and simulated cuts bind `barPublicationPolicy: observed-completed-history.v1`. Only the latest completed
minute retains the publication deadline: 60 seconds to finalize plus 10 seconds for publication, or 90 seconds plus
10 seconds for an `updatedBars` correction, with the existing five-second clock allowance. Historical finalized
minutes can arrive through recovery before the decision. Their actual arrival times remain part of the immutable cut.
Executable quote and trade freshness is unchanged.

Every selected bar revision must match the native feature's exact coordinates and content hash. Equivalent revisions
retain their original publication witness; changed market values start a new history. Reconstruction verifies both
actual deliveries and rejects altered, premature, future or out-of-cut evidence. Retired policy markers are rejected;
there is no alternate legacy timing path.

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
