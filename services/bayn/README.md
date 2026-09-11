# Bayn

Bayn is a single-writer intraday execution service. Restate schedules one account-keyed controller, pure TypeScript
decides what should happen, Effect interprets one bounded pass, PostgreSQL stores trading truth, TigerBeetle stores
accounting truth, and the broker adapter performs account-environment-neutral execution.

There is one active strategy: `intraday-momentum` using `bayn.intraday-momentum.protocol.v2`. Historical strategy
rows remain decodable for audit and reconciliation, but they are not runtime fallbacks and cannot create new cycles.

## Active strategy

The submission window opens with the regular session. Bayn waits for its first fully elapsed 30-minute IEX window and
the two-second decision delay, without an additional clock warmup. It evaluates subsequent rolling windows until
five minutes before the close. It compares AAPL, AMZN, IWM, NVDA, QQQ, and SMH against SPY and requires:

- positive candidate momentum and non-negative SPY momentum;
- at least 10 basis points of excess momentum;
- a top-quartile location in the rolling range;
- a spread no wider than 5 basis points; and
- valid rolling-bar evidence plus fresh executable quotes and trades.

The strategy selects at most one long position and caps it at 10% of the mandate allocation. A valid `NO_TRADE` is a
normal decision; unavailable mandatory evidence blocks evaluation. New entries use whole-share
IOC limit orders at an adverse verified quote boundary. Bayn starts flattening five minutes before the close and
requires a flat account at the closing bell. Entries stop when flattening starts, and close orders remain eligible
until the actual close, including early-close sessions. The five-minute exit budget is an operational policy;
unfilled exits or unresolved reconciliation remain incomplete and visible.

During that close window, missing or over-late archive evidence, a retryable archive outage, or an archive read
timeout triggers a fresh broker reconciliation and the existing market/DAY close path. The close binds the exact
reconciled holdings and cannot exceed their remaining quantity. The archive read receives at most half the smaller
of the remaining execution-pass budget and remaining close window. It additionally reserves twice the already
elapsed preparatory work for a fresh reconciliation and close planning; a slow initial reconciliation therefore
leaves less time for archive reads. The overall pass and close deadlines still apply.
Malformed archive identities, hashes, ordering and lineage still fail. Unknown mutations, unresolved orders,
inexact reconciliation, stale broker state and expired close authority still prevent submission. This exit policy
is part of behavior v13; entry decisions retain their existing evidence and LIMIT/IOC requirements.

Entry observations evaluate candidate availability independently. Missing or late candidate bars, quotes, or trades
exclude that candidate with an explicit reason while other candidates remain eligible for evaluation. SPY is the
mandatory benchmark. Source identity, canonical ordering, watermarks, finality, and premature data still fail the
whole observation. Raw candidate rows and their exclusions remain in the hashed snapshot for revalidation.

The v3 strategy target records measured signals separately from excluded candidates. Measured signals retain their
threshold rejections and selection rank; eligible candidates outside the position limit remain visible. An observation
with every candidate excluded remains unavailable and cannot establish a valid `NO_TRADE`. Execution pricing requires
fresh quotes for positive targets and reconciled holdings. Legacy v2 targets remain readable for audit.

Quotes, trades, and finalized bars ingested beyond their declared delay limits remain invalid. Candidate exclusion
does not relax those limits. Required benchmark and execution evidence must become available within the existing
deadlines. An invalid historical bar remains invalid while it is in the rolling window; waiting only helps once a
compliant window is available. Premature feed evidence, non-final bars, and unclassified freshness violations remain
errors. Historical replay uses the same candidate evaluation and retains every rejected observation.

The protocol, universe, thresholds, feed contract, and execution model are source-controlled TypeScript. The image
embeds and verifies the source revision and the behavior, parameter, protocol, and risk-policy hashes.

## Execution contract

- `BAYN_BROKER_ACCESS` and `BAYN_CAPITAL_AUTHORITY` are static capability ceilings. Effective execution additionally
  requires an exact durable grant bound to the source, image, strategy, account, and risk policy.
- Sandbox and live accounts use the same decisions, intents, risk checks, reconciliation, recovery, and mutation code.
  Only broker configuration and the durable grant differ.
- Every intent, client-order ID, risk decision, and mutation transition is committed before broker I/O. Unknown broker
  outcomes block new exposure until deterministic lookup and reconciliation resolve them.
- Execution is long-only. Sells cannot exceed reconciled inventory. Entry, gross exposure, turnover, loss, drawdown,
  cutoff, and stale-data limits fail closed.
- PostgreSQL and TigerBeetle must reconcile exactly. Identity drift, unresolved mutations, stale broker evidence,
  duplicate controllers and accounting discrepancies block new orders. Unavailable archive evidence blocks entry;
  the bounded close-only path can instead bind freshly reconciled broker positions.

An accepted LIMIT/IOC entry may finish canceled after filling only part of its requested quantity. Bayn verifies the
exact broker order and intent identity and treats a positive fill smaller than the requested quantity as settled
entry exposure, without restricting authority or submitting the unfilled remainder. The cycle remains open for its
scheduled close. Rejected, mismatched, overfilled, and non-IOC canceled orders retain their failure handling.
Durable completion additionally requires the recorded partial fills to match the accepted order, a later trusted flat
position snapshot, exact reconciliation covering the account's latest broker events, and no open broker orders.

When a worker resumes an existing PAPER grant under a recognized system failure restriction, it runs close-only
recovery. It cannot discover new cycles or submit entries. During the existing close window it can cancel outstanding
orders belonging to the bound cycle and submit the existing position-reducing close after fresh exact reconciliation.
The persisted kill state remains active, and broker identity, unknown-order, quantity, accounting, and close-deadline
checks still apply. Operator restrictions do not enter this recovery path.

Mutation preparation uses its verified durable decision and session binding plus fresh broker reconciliation. It does
not reread the market calendar after the decision is bound, so an unrelated calendar outage cannot prevent accepted
order recovery or the scheduled close. New decision construction still reads and verifies the broker calendar.
Broker-session startup verifies account identity and permissions, account configuration, positions, orders, fills,
and order lookup access. It does not require the calendar endpoint, so an outage cannot prevent a replacement worker
from starting recovery of a bound decision.

Broker reconciliation recaptures changing history or lagging fill activities at most twice, 500 milliseconds apart,
before persisting a snapshot. A broker terminal fill may precede local acknowledged-intent recovery; recorded terminal
outcomes and aggregate fills still must agree. Equity marks from separate account and position observations remain
visible as valuation differences, while cash, inventory, cost basis, fees, and ledger reconciliation remain exact.
Flat accounts and marks observed at the same instant also require exact equity agreement.

## Runtime architecture

- `BaynExecutionController` is the only scheduler. Restate serializes handlers by canonical account-binding hash,
  persists timers and retries, and resumes after worker replacement.
- The execution worker runs one bounded `advanceExecutionOnce` pass per tick. Restate is not treated as broker
  exactly-once delivery; durable intents and deterministic IDs remain the external-side-effect boundary.
- PostgreSQL is the authoritative cycle, grant, intent, mutation, reconciliation, and controller-status ledger.
- Each writer transaction reserves its own PostgreSQL connection and holds the advisory fence through commit or
  rollback. A disconnected transaction fails without replaying its writes; the next pass obtains a usable connection
  and reconciles durable state. Nested fence calls stay in their owning transaction.
- Recovery recognizes a cycle that completes with verified zero fills after a system failure restricts authority.
  It still requires fresh exact, flat reconciliation and the normal OBSERVE successor before reactivation. An operator
  kill remains restricted.
- TigerBeetle is the authoritative fee, cost-basis, cash, and realized-P&L ledger.
- Reconciliation reads Alpaca `FEE` activities alongside fills and orders. Each fee or refund has an immutable
  account/activity identity and a deterministic cash/fee-expense ledger transfer. Delayed fees update exact cash
  reconciliation without changing the opening balance or inventing fills; changed or missing activity history fails
  closed. Fees dated before the opening cash baseline require earlier baseline evidence and are rejected before any
  ledger post; their date alone cannot prove when they settled. Descriptions are not retained because they may contain account details.
- Forward performance deducts delayed fees by their trading date when that date belongs to one authority generation.
  Fees on dates shared by generations leave the receipt insufficient until allocation is supported. Account-wide
  ledger verification includes all fees; cash-yield calculations account for their actual observation window.

- The public Bayn deployment serves read-only status and health. It does not schedule execution or hold mutation
  authority.
- Broker egress is restricted to the configured Alpaca endpoint through the dedicated CONNECT proxy. Credentials and
  plaintext account identity must never appear in logs, metrics, traces, or status responses.

## Market data

Alpaca WebSocket events flow through Kafka and the Dorvud/Flink archive into ClickHouse. Bayn reads the retained
`intraday_bars_1m_v2`, `intraday_quotes_v1`, and `intraday_trades_v1` tables with a read-only identity. Each decision
binds exact topic watermarks, content hashes, session calendar, universe, feed, observation window, and freshness
limits. Bayn owns no ClickHouse DDL or backfill path.

## Operations

Normal delivery uses the shared Kargo path:

1. merge reviewed source to `main`;
2. build the exact multi-architecture image and publish its immutable `kargo-sha-<source>` alias;
3. let the `bayn` Warehouse and automatic Stage copy that source into `kargo/bayn`, update all three runtime image
   bindings and the existing research build lineage, and push the generated GitOps commit; and
4. let Argo reconcile the execution worker, activation hook, and status service in their existing sync order.

Builds are scoped to Bayn inputs and finish when later commits arrive. There is no separate release workflow or
promotion-eligibility script. Kargo controls delivery; the native activation hook and runtime enforce the configured
account, strategy, capital grant, reconciliation, and order-risk contracts.

Do not deploy directly or submit a broker order manually. A code release does not change the sealed research request
or grant live capital authority.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: current dependency and execution-readiness projection.
- `GET /v1/status`: bounded controller, strategy, authority, cycle, reconciliation, accounting, build, and blocker
  state.

The read-only forward-performance command can isolate one durable mandate. Take the exact
`capitalActivation.generationHash` from `/v1/status` when `capitalActivation._tag` is `Realized`, and run it in the
configured runtime:

```sh
node dist/forward-performance-command.js --authority-generation <generation-hash>
```

Without that option, the command evaluates account history, which may span retired strategies and mandates.
Malformed or ambiguous arguments fail before configuration or evidence reads. A generation-scoped receipt still
requires completed executions and exact accounting; operational readiness and an active research mandate do not
establish profitability.

A standing mandate's next scheduled cycle does not make the reconciled performance window incomplete while its
submission window is still in the future and it has no durable decision or intent. Blocked cycles, started cycles,
and any future cycle with durable execution work still prevent a sufficient receipt.

## Historical intraday replay

The intraday protocol admits quote and trade evidence up to 10 seconds old at the observation time. The previous
2-second budget was shorter than the existing Kafka/Flink/ClickHouse delivery path: September 10 live samples showed
SPY quote ages of 1.3–4.6 seconds despite roughly 40 milliseconds from provider event to websocket receipt. The
10-second bound gives the archive time to publish usable evidence for the 30-minute signal. Future timestamps,
evidence beyond the bound, missing bars, spread and signal requirements, and quote-bound IOC prices still block
execution. Changing this bound changes strategy identity and requires normal activation; it is not profitability proof.

`bayn-intraday-replay --input <path>` evaluates finalized sessions from an exported Alpaca calendar against the retained
intraday archive. It reads ClickHouse using `BAYN_CLICKHOUSE_URL`, `BAYN_CLICKHOUSE_USERNAME`, and
`BAYN_CLICKHOUSE_PASSWORD`. By default, `archiveAvailability: "recorded-reader"` also requires the configured PostgreSQL
receipt store (`BAYN_POSTGRES_URL`, `BAYN_POSTGRES_TLS`, and `BAYN_POSTGRES_CA_PATH`). Its PostgreSQL transactions are
read-only and bounded; it does not run migrations or record receipts. The command has no broker mutation, TigerBeetle,
or capital-grant capability.
Run `bun run --filter @proompteng/bayn build` for the local equivalent:

```sh
node services/bayn/dist/intraday-replay-command.js --input replay-input.json > replay-report.json
```

The input declares the calendar range, capital, and execution assumptions before the run. For example, after exporting
the exact calendar response for this date range:

```json
{
  "schemaVersion": "bayn.intraday-replay-input.v2",
  "range": { "start": "2026-09-04", "end": "2026-09-04" },
  "calendar": [{ "date": "2026-09-04", "open": "09:30", "close": "16:00" }],
  "initialCapitalMicros": "100000000000",
  "allocationCapitalMicros": "100000000000",
  "archiveAvailability": "recorded-reader",
  "operationalTiming": {
    "decisionReadMs": 2000,
    "decisionComputeMs": 1000,
    "planningReadMs": 2000,
    "planningComputeMs": 1000,
    "commitMs": 1000,
    "submissionMs": 2000
  },
  "assumptions": {
    "pollIntervalMs": 30000,
    "firstPollDelayMs": 2000,
    "orderLatencyMs": 100,
    "availableLiquidityPpm": 1000000,
    "slippageBps": 0,
    "feeMultiplierPpm": 1000000
  }
}
```

All six operational durations are required, including an explicit zero for an intentionally omitted stage. The
example durations are experiment assumptions, not calibrated latency estimates. Source cutoff and reader completion
are separate: decision and planning retain the same cutoff as the live path, while computation, planning, commit,
submission and venue arrival advance in order. `orderLatencyMs` covers submission-to-arrival only and admits 1–60,000
milliseconds. Stage durations admit 0–300,000 milliseconds. A late submission creates no order; a close arriving beyond
the hard-flat deadline remains incomplete. The next attempt waits the declared poll interval after the modeled work completes, matching the controller's
completion-based scheduling. Snapshot `availableBy` fields state consumption bounds, not invented reader receipts.

The range is bounded to 31 calendar days. Preserve the complete calendar response; archive date presence cannot
establish that a session was open or that its data is complete. Each scheduled observation reconstructs archive
watermarks with event and source-receipt times bounded by that observation. Source receipt is the WebSocket mapper's
timestamp, before Kafka, Flink, and ClickHouse delivery; neither that timestamp nor a retrospectively reconstructed
watermark proves historical reader visibility.

The execution worker therefore records append-only `bayn.archive-record-availability.v1` receipts after a successful
archive read completes. Each retains the raw record, canonical Kafka identity and content hash, snapshot identity,
source cutoff, read-start and completion clocks, reader endpoint hash, and verified source/image identity. The
completion time is rounded up to the next millisecond, never backdated to the source cutoff. Retries retain the first
stored observation; changed content under the same source identity fails closed. The public status service and replay
commands cannot mint these receipts. Recording failure prevents release of that read to the execution caller.

Default replay requires a matching production-reader receipt for every used row, completed no later than the declared
reader-completion clock for a decision or close-pricing read. Arrival and equity-mark evidence retain their own
source-time bound. Missing or late receipts for an independent decision candidate exclude that candidate with zero weight;
the shared strategy core ranks the remaining candidates. These reader-derived exclusions are bound separately in
`availability.snapshots[].candidateExclusions`, without rewriting the immutable archive manifest or discarding raw
excluded rows. Valid late receipts are retained as exclusion evidence, never as proof of availability at the declared consumption clock.
Missing benchmark or execution-pricing evidence still rejects the whole observation. Corrupt, duplicate, unrelated,
development-only, or conflicting receipts remain global failures, including receipts belonging to excluded candidates.
An entry window with all candidates unavailable remains incomplete, not a clean `NO_TRADE`, and prevents aggregate P&L.
Receipts cover rows actually
observed by the worker, not the entire feed. They are conservative availability upper bounds, not earliest visibility,
simultaneous snapshot proof, reader uptime, or actual execution evidence. In particular, a read completing after its
query cutoff becomes consumable only when its declared completion clock reaches that receipt; its source cutoff
and snapshot identity remain unchanged. Strict-mode coverage can remain sparse; this does not reconstruct
missing historical delivery times or establish a complete live-equivalent backtest.

Existing source-time experiments may explicitly freeze `archiveAvailability: "source-receipt-assumption"` in their input.
That mode remains ClickHouse-only and retains the original economic counterfactual, but its availability is always
`UNPROVEN`; it cannot be presented as production-visible or causal execution evidence. Omitted policy now defaults to
recorded receipts, not this assumption. There is no automatic fallback or historical receipt backfill.

The report retains decision, planning, arrival and mark manifests, receipt bindings and deduplicated raw receipts,
stage timelines, data failures, canceled IOC quantities, fees, cash, and unclosed positions. Retain the report alongside the frozen input.

The fill model uses whole shares, the opposite arrival quote, a declared share of displayed liquidity, and adverse
slippage. A modeled price beyond the submitted limit cancels the order. Zero added slippage still includes crossing
the quoted spread and the protocol's fees. `feeMultiplierPpm` scales the fees before their normal rounding. Execution
assumptions describe a counterfactual; they do not measure queue position or actual broker fills. An archive outage
that requires the broker market/DAY close fallback is incomplete because this harness has no verified fill model for
that recovery. It never substitutes a later IOC or an invented market fill.

The retained September 10 conformance fixture reproduces the IWM decision, candidate exclusions, 34-share target and
287.93 limit under its original v11 identity and 2-second quote-age protocol. All 223 row receipts match the original
snapshot. Its cutoff was 19:50:27.072Z, reader completion 19:50:29.128Z, planning reader completion 19:50:32.224Z and
submission start 19:50:35.817Z. No venue-arrival timestamp was retained. This fixture proves historical conformance;
it is not economic evidence for the current strategy.

The `bayn.intraday-replay-report.v4` report includes explicit availability policy/evidence and holding-period equity marks from adverse verified archive bids,
observed drawdown, carried peak equity, and diagnostic daily-loss/drawdown-limit breaches. Marks use the declared
30-second poll interval, so excursions between observations can be missed. Missing required mark evidence makes the
session incomplete while preserving attempted closes, fees, fills, and remaining positions. These diagnostics do not
change order decisions or represent the full live risk controller.

Every report is `COUNTERFACTUAL_RESEARCH` and `NOT_QUALIFIED`, including a positive result. A report does not create a
qualification, change a strategy, activate capital, or replace the forward-performance receipt. Use a declared
chronological holdout and sufficient independent sessions before drawing a profitability conclusion; inspect the
report's limitations and incomplete sessions rather than selecting only favorable dates or assumptions.

### Archive study across independent sessions

Use `bayn-intraday-replay --study <path>` to evaluate every declared archive session under multiple frozen execution
assumptions. The command uses the same availability policy, read-only data configuration, and active strategy implementation.
Each date starts flat with the same initial capital. An incomplete date remains in the report and does not skip later
dates; these independent experiments do not represent a continuous portfolio. The ordinary `--input` mode continues
to carry cash and stop after incomplete sessions.

The study input has `schemaVersion: "bayn.archive-replay-study-input.v1"`, `sessionMode: "independent-flat-start"`,
`experimentPlanHash`, the frozen `strategyProtocolHash` and `riskPolicyHash`, and `scenarios: [{ name, input }]`.
Each scenario's `input` is the complete `bayn.intraday-replay-input.v2` object above. Scenarios must have unique names
and identical calendars, date ranges, and starting/allocation capital and availability policy. Only execution assumptions and operational timing may differ. Freeze
the plan and all scenarios before examining their evaluation returns; a supplied plan hash records identity, not proof
of preregistration. The command rejects strategy/risk identity drift before archive reads.

Every nested replay retains its report hash, exact Kafka topic/partition offsets, event and ingestion times through
the verified snapshot manifests, data failures, orders, fills, and accounting. Aggregate independent-session P&L is
null whenever any declared date is incomplete. Winning/losing counts describe completed independent experiments only;
they are not a win/loss rate over the whole calendar. Zero fills are reported explicitly and do not establish an edge. All
results remain research-only and cannot change broker or capital authority. Progress is JSON on stderr; stdout contains
one complete JSON report. Add `--output-directory <new-directory>` to atomically save each completed session's full
report and frozen study/plan identity before starting the next session. The directory must not exist and its parent
must exist; existing evidence is never overwritten. These files survive interruption but are not a completed study
or a resume cache. Neither the study nor the normal replay consumes or commits a Kafka consumer-group offset.

```sh
node services/bayn/dist/intraday-replay-command.js --study archive-study.json \
  --output-directory archive-study-sessions > archive-study-report.json
```

## Vendor historical research

`bayn-vendor-intraday-replay --input <path> --cache <directory>` evaluates a frozen historical experiment using Alpaca
IEX history. It shares the active strategy's decision, sizing, IOC, and fee arithmetic. It reads market data and writes
the explicitly named local cache; it has no broker mutation or capital-grant capability.

```sh
node services/bayn/dist/vendor-intraday-replay-command.js \
  --input vendor-input.json --cache ./vendor-cache > vendor-report.json
```

The input uses `bayn.vendor-intraday-replay-input.v1`. Supply the calendar, range, initial capital, and allocation
capital as above, with a range of at most 120 calendar days. Export the complete official calendar in requests of at
most 31 days before combining it. Additional required fields are:

- `experimentPlanHash`: the hash of the experiment plan frozen before inspecting evaluation prices or returns;
- `strategyProtocolHash`, `behaviorHash`, `parameterHash`, and `riskPolicyHash`: the frozen active identities, checked
  against the implementation before data reads; and
- `scenarios`: uniquely named `{ "name": "baseline", "assumptions": { ... } }` entries using the same explicit
  execution assumptions as archive replay. Preserve every declared scenario in the analysis.

The command uses `BAYN_ALPACA_KEY_ID`, `BAYN_ALPACA_SECRET_KEY`, and `BAYN_ALPACA_PROXY_URL` (default
`http://bayn-egress-proxy:3128`). Historical reads target only `data.alpaca.markets`, with IEX, session-date symbol
mapping, and raw one-minute bars. The client consumes every page, limits requests to 180 per minute, and verifies
cached query, raw-page, normalized-content, and pagination hashes before reuse. Quote and trade requests cover only
the protocol's freshness window at each observation; bars cover the bounded session decision range. Preserve the cache with the report
to retain its source evidence. Progress and failures go to stderr; stdout contains the final canonical JSON report.
Use one writer per cache directory. A checksum mismatch stops the run; preserve that cache for diagnosis and use a
new directory for a fresh capture. Do not overwrite corrupt evidence and present it as the original capture.

Vendor history proves event-time observations and completed provider queries. It cannot prove when a production
consumer received a record, whether a historical bar was later revised, or which immutable archive version existed
at a simulated decision. Vendor evidence therefore has its own provenance hash and never receives archive snapshot,
ingestion-time, or Kafka identities.

`quoteSizePolicy: native-unit-share-cap.v1` preserves the active strategy's capacity arithmetic: one modeled share
per provider-native quote-size unit, before the scenario's liquidity reduction. This is a conservative capacity
assumption, not a verified round-lot conversion. Preserve raw sizes and resolve the feed's unit contract before
using results as execution-readiness evidence. IEX quotes describe one exchange; they do not prove consolidated
liquidity or broker fills. Trade confirmation uses raw historical trades, not the latest-trades endpoint's
bar-forming condition filter.

Each scenario carries cash and positions chronologically. Planning and arrival prices are separate observations;
unfilled IOC orders stay canceled and incomplete flattening retains the residual position. Long inventory is valued
at verified adverse bids on the declared 30-second schedule. Reports retain observed equity, loss, peak, and drawdown,
including excursions followed by recovery. Missing mark evidence makes the economic path incomplete. Observed
drawdown can miss excursions between samples and cannot establish continuous live risk compliance.

These reports remain `COUNTERFACTUAL_RESEARCH` / `NOT_QUALIFIED`. Keep retrospective development exposure, all tested
alternatives, costs, canceled orders, and incomplete sessions visible. Positive historical returns do not replace
independent prospective execution evidence or grant trading authority.

## Validation

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn test:postgres
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn lint:oxlint
bun run --filter @proompteng/bayn build
```

PostgreSQL tests require an isolated database whose name ends in `_test`; never point them at a live Bayn database.
Historical development candidates are terminal, non-executable records summarized in
[`docs/bayn/candidate-terminal-history.md`](../../docs/bayn/candidate-terminal-history.md).
