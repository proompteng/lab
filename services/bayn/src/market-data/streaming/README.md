# Streaming market data

The execution worker uses `BAYN_MARKET_DATA_MODE=streaming` with `BAYN_KAFKA_BROKERS`, `BAYN_KAFKA_USERNAME`,
`BAYN_KAFKA_PASSWORD`, and `BAYN_KAFKA_TIMESTAMP_POLICY=dorvud.producer-clock.v1`. The reviewed bootstrap deadline
is 300 seconds. SCRAM-SHA-512 uses the existing 9092 listener. The KafkaUser secret reaches Bayn through the existing
secret reflection path. The public status service and archive research commands do not start a consumer.

Optional shadow mode keeps archive execution and compares raw input hashes and strategy results at the same observation.
Logs distinguish different input cuts, unavailable streams, invalid decisions and matching or mismatching decisions.
Streaming execution blocks when its required inputs are unavailable. Any mode change requires reviewed GitOps.

The initial retained-data probe consumed 905,542 records across all 22 partitions in 223 seconds on the slower worker, with no rejections and exact feature matches for all strategy symbols and SPY. The five-minute budget bounds catch-up; normal calendar, exact-window, and quote-freshness checks still run after it.

A replacement consumer captures partition bounds and rebuilds the required 30-minute window before serving inputs.
Offsets are committed only after incorporation or explicit rejection. The projection retains 61 bar minutes, 512
quote/trade updates and 64 feature revisions per symbol, plus 256 rejections per partition. Windows that need
discarded rejection history fail verification. An observation older than retained history fails.
Reassignment discards the old projection. Connection attempts are bounded; after exhaustion, a later read can
request a fresh rebuild after a 30-second cooldown. Scope closure cancels consumption and closes the client.

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

Live snapshots and historical observations share `selectStreamingInputs` for raw selection, exact feature revisions,
candidate exclusions, and input validation. The live constructor separately requires observed availability and a
complete Kafka source cut. Calling the shared selector cannot turn a simulated projection into live execution evidence.

`createHistoricalMarketCursor` and `advanceHistoricalMarketCursor` accept ordered arrivals incrementally and retain
only the projection's bounded history. Both the cursor and the existing JSON runner use the same arrival ordering and
reducer. The JSON command below still has its explicit 500,000-record input limit and evaluates one observation; the
incremental cursor is the input primitive for the full-session execution driver, not an execution or accounting receipt.

```sh
node dist/streaming-replay-command.js --historical experiment.json
```

The input uses `bayn.historical-streaming-strategy-input.v1`, the current strategy's `protocolHash` and
`behaviorHash`, a `sessionDate`, the retained Alpaca `calendar` response (`date`, `open`, `close`), and an
`arrivals` document described below. The command validates the calendar, decision interval, raw records,
freshness, and exact feature-to-bar joins before calling the same intraday momentum core. It evaluates all six
candidates and SPY. Missing candidates remain explicit exclusions; a missing benchmark or absence of every
candidate rejects the experiment observation. Invalid input cannot become a successful no-trade result.

The resulting research receipt binds the input, protocol, behavior, calendar, delivery model, window, selected
feature payloads and simulated arrival times to its content hash. It contains signals and target weights,
without an executable snapshot or order authority. `--historical` reads only the supplied file and opens no
database, Kafka, or broker connection. Keep the source export with the receipt to reproduce the run.

`replayHistoricalMarketArrivals` uses the same reducer with an immutable run ID, supplied arrival times and the
declared `availability-topic-partition-offset` tie-break. It consumes original raw envelopes and feature payloads
exported with their Kafka coordinates. A delivery model that reverses offsets within one Kafka partition is rejected
before projection, including reversals later in the supplied experiment. Its output explicitly identifies simulated consumer availability. Feature
computation timestamps are never backdated. A `regeneratedFeatures` declaration binds the generation run ID and
actual recording time when an experiment assigns earlier simulated arrivals. Every historical projection is marked
as simulated and is rejected by the live snapshot boundary. A regenerated feature therefore cannot be represented as an original
historical receipt.

The existing bar archive stores ingestion times at millisecond precision. Exact feature-input reconstruction must join archived bars to feature provenance by Kafka coordinates, recover the original nanosecond timestamp from that provenance, and verify every producer content hash. A millisecond row alone cannot establish the original nanosecond revision. The deployment check verified all 180 referenced bar hashes for six features through this path.

The existing archive economics harness remains a separate evidence mode. Feature plumbing, deterministic replay and
PAPER operation do not establish profitability.

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
bound to the run and reproduced cut. Raw, rolling and technical topics must be distinct. The regeneration timestamp
applies only to rolling features, retaining actual computation time separately from simulated availability. Original
technical records must pass the normal computation-to-arrival clock bound. The historical economic study
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
BAYN_REPLAY_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:55432/bayn_replay \
BAYN_REPLAY_TIGERBEETLE_ADDRESS=127.0.0.1:53000 \
BAYN_REPLAY_TIGERBEETLE_CLUSTER_ID=20912 BAYN_REPLAY_TIGERBEETLE_LEDGER=70912 \
node dist/session-replay-command.js --input session.json --arrivals source.ndjson \
  --capture capture.json --capture-sha256 "$CAPTURE_SHA256" --output new-run-directory
```

Run this command against separately provisioned local stores. It accepts only local PostgreSQL databases whose names
end in `_replay`/`_test` (or `replay`/`test`) and a local TigerBeetle replica. It requires an unused PostgreSQL authority
state and never clears either database. Give each attempt a distinct `replicate` in the frozen input; resetting
PostgreSQL while retaining TigerBeetle under the same run ID is not a fresh run. Database clients close with the command. A 30-minute wall-clock deadline bounds a stalled offline run without changing its modeled session interval.
The normal service composition does not load this command or its virtual clock.

`bayn.execution-replay-session.v1` binds the calendar session, source manifest, unchanged source-controlled strategy
and build, opening cash, IOC latency/liquidity/slippage/fee assumptions, and production polling/reconciliation cadence.
It also retains asset metadata and its observation time. Asset eligibility captured after the session must explicitly
use `counterfactual-current-asset-eligibility`; it cannot be described as historical as-of evidence. Embedded builds
must match the input build; source invocations identify their build verification as `development-configured`.

The `bayn.retained-replay-source.v1` manifest binds the SHA-256 of the complete NDJSON file, record count, export
coverage interval, first/last arrival, partition bounds, universe, origin, and delivery policy. Each line uses
`HistoricalMarketArrivalSchema`. The reader verifies the entire file before execution, then reads bounded chunks
while retaining the production projection. It rejects duplicate/reversed Kafka coordinates, reversed availability,
records outside the frozen cuts, and changed bytes/counts. The current Torghut capture profile independently requires
three bar partitions, thirteen quote partitions, three trade partitions, and three retained feature partitions.
The offline regenerated feature stream has its own single partition. Every partition needs a cut, including empty
cuts with equal start/end offsets. Record-derived partition inventories cannot establish source completeness.
The verified first and last arrivals must also span the exchange session; declared coverage alone is insufficient.
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

The required capture receipt uses `bayn.replay-source-capture.v1` with `capturedAt`, `origin`, `coverageStartMs`,
`coverageEndMs`, `universe`, and complete `positions` (`topic`, `partition`, `startOffset`, `endOffsetExclusive`).
Capture the raw cuts with Kafka ListOffsets at both requested boundaries, resolving a missing timestamp match to the
captured high-water mark. Obtain regenerated-feature extents from the independently retained producer receipt.
Freeze the receipt and its byte SHA-256 at capture time; do not derive them from whichever records the replay export
happens to contain. Supply that trusted hash through `--capture-sha256`. The command checks both receipt bytes and
every manifest cut before touching a database, copies the receipt to its output, and binds its hash into the run ID
and final report. This establishes completeness relative to the pinned capture authority; it does not authenticate
market prices or calibrate the data feed.

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
