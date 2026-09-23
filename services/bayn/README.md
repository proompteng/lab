# Bayn

Bayn is a single-writer intraday execution service. Restate schedules one account-keyed controller, pure TypeScript
decides what should happen, Effect interprets one bounded pass, PostgreSQL stores trading truth, TigerBeetle stores
accounting truth, and the broker adapter performs account-environment-neutral execution.

The source selects one active strategy, `jev`, using `bayn.jev.protocol.v1`. Historical strategy
rows remain decodable for audit and reconciliation, but they are not runtime fallbacks and cannot create new cycles.

## Active strategy

Bayn supplies TypeSafe's pinned `jev-1.13.0` System One model with verified prices, volume, computed technical
indicators, quotes, benchmark relationships and actual position context. Bayn computes quantities, cost basis,
holding time, returns, sizing and risk. The model returns typed probability distributions for entry or management.

The [TypeSafe SDK response contract](https://docs.typesafe.ai/sdk/python/api/types/responses#typesafe_sdk.ChoiceAnswer)
describes approximately normalized probabilities. Bayn requires a normalized distribution to fit within 0.005 of
each reported probability, so the total allowance scales with the number of choices. These are Bayn validation bounds, not a
provider precision guarantee. Score answers must also fit the same distribution bounds and a 0.005 score allowance.
Bayn retains the reported values and hashes without normalization. Selection uses reported probabilities; larger
discrepancies, mismatched choices or inconsistent scores remain unusable evidence.

The submission window opens with the regular session. Bayn waits for its first fully elapsed 30-minute IEX window and
the two-second decision delay. It evaluates the source-controlled candidate universe against SPY until five minutes
before the close. The default development protocol requires an entry probability of at least 0.65 and a spread no
wider than five basis points. It selects at most one long position, capped at 20% of account equity and reduced when
the actual weighted target would exceed order, symbol, exposure or remaining daily turnover limits. The daily counter
includes both buys and sells. Allocation reserves slippage and any current exposure's liquidation notional before
bounding the target; the target weight is applied once. Exposure-reducing closes retain their existing risk exception.
The order cap reserves its full price allowance before sizing because it checks executable notional. Symbol, gross
and net exposure caps retain their reference-price basis. Buy-limit rounding stays inside the reserved allowance.
A complete batch must remain valid within its five-second evidence lifetime. These parameters have not established
an economic advantage under the frozen qualification protocol.

Position management uses accounted entry fills and fresh reconciliation. A model exit requires probability of at
least 0.65. A 15-minute holding limit starts at the first actual fill. A verified adverse bid can trigger the
50-basis-point protective stop. Its initial close must commit before the triggering quote expires, measured from the
quote's event time. The immutable exit target binds that deadline. These deterministic exits do not require Jev.
PostgreSQL checks the initial exit deadline in a deferred constraint at transaction commitment, after evidence reads
and insertion. A late transaction rolls back. Production uses the database wall clock; replay uses its persisted
account clock. This is the server acceptance boundary, not a guarantee about when the commit acknowledgment arrives.
A committed close retains its original trigger through partial fills and recovery after the inference deadline.
New entries and quote-backed whole-share closes use
IOC limit orders with a price allowance bounded by the existing risk policy, currently 10 basis points from the
verified ask for buys or bid for sells. Prices round toward the quote to stay within that allowance. The durable
decision retains the original quote, phase-specific allowance, exact limit notional, and risk evidence; historical decisions without
an allowance retain their original exact quote limit. Quote freshness and submission deadlines still apply.
Bayn starts flattening five minutes before the close and
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
preserves the reviewed close authority; entry decisions retain their evidence and LIMIT/IOC requirements.

Entry observations evaluate candidate availability independently. Missing or late candidate bars, quotes, or trades
exclude that candidate with an explicit reason while other candidates remain eligible for evaluation. SPY is the
mandatory benchmark. Source identity, canonical ordering, watermarks, finality, and premature data still fail the
whole observation. Raw candidate rows and their exclusions remain in the hashed snapshot for revalidation.

Native Jev targets retain every candidate result and source exclusion with the exact full-batch evidence. An
observation with every candidate excluded remains unavailable. Execution pricing requires fresh quotes for positive
targets and reconciled holdings. Historical momentum targets remain readable for audit.

Entry and position-management observations each commit at most once per completed signal window within a cycle.
Later polls and process restarts consult the retained observation before creating another inference batch. The next
evaluation requires the next completed minute and its decision delay. An interrupted or failed observation does not
authorize another inference attempt on the same window. Protective stops and the holding limit remain eligible on
every management pass.

Quotes, trades, and finalized bars ingested beyond their declared delay limits remain invalid. Candidate exclusion
does not relax those limits. Required benchmark and execution evidence must become available within the existing
deadlines. An invalid historical bar remains invalid while it is in the rolling window; waiting only helps once a
compliant window is available. Premature feed evidence, non-final bars, and unclassified freshness violations remain
errors. Historical replay uses the same candidate evaluation and retains every rejected observation.

The protocol, universe, thresholds, feed contract, and execution model are source-controlled TypeScript. The image
embeds and verifies the source revision and the behavior, parameter, protocol, and risk-policy hashes.

## Execution contract

The Jev implementation lives under `src/jev`. The trading-signal batch constructor requires the complete retained
observation, derives its observation and protocol hashes, reproduces the live or simulated snapshot once, and freezes
the complete candidate universe, source exclusions, exact requests and common deadline. Batch results bind every
planned candidate, including failed, abandoned and unattempted evaluations.
Reproduction detects a rehashed plan that omits a candidate or substitutes model input. Selection requires the whole
batch to remain valid after completion and persistence; it cannot use only the fastest successful response.

The batch store commits the full plan before any candidate request can be claimed. It finalizes results from the
database's request receipts and resolutions, serializes competing recovery, and seals unattempted requests at expiry.
Lost acknowledgements and process restarts replay committed evidence without repeating inference. Late responses
remain available for accounting but cannot change an abandoned resolution or a finalized batch.

Native decision binding and position management use these contracts. Deployment and full lifecycle acceptance
remain separate requirements. Historical inference evidence, an API response, or a batch result grants no execution
or capital authority. Economic qualification uses the frozen protocol in
[`docs/bayn/jev-migration-acceptance-v2.json`](../../docs/bayn/jev-migration-acceptance-v2.json).

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
entry exposure, without submitting the unfilled remainder. The cycle remains open for position management and exit. Rejected, mismatched, overfilled, and non-IOC canceled orders retain their failure handling.
Durable completion additionally requires the recorded partial fills to match the accepted order, a later trusted flat
position snapshot, exact reconciliation covering the account's latest broker events, and no open broker orders.

A completed Jev position or an exact zero-fill LIMIT/IOC cancellation can release an intraday attempt before the close. Bayn first requires a later exact flat reconciliation with no unknown mutations or open orders. The
attempt then completes without inventing a fill. After at least one minute, while the entry cutoff remains open, the
standing mandate may create the next rolling observation across all strategy candidates. Zero-fill attempts do not
exhaust a session-wide quota. Each new attempt requires fresh signals and pricing, exact flat reconciliation, no
unresolved mutations or open orders, and the existing risk limits. Attempts use increasing ordinals, distinct immutable
v4 cycle identities, and unique PostgreSQL authority slots. Filled and partially filled attempts remain bound until
all exits settle and durable completion proves the account flat. Failed or ambiguous outcomes retain their existing
fail-closed handling.

When a worker resumes an existing PAPER grant under a recognized system failure restriction, it runs close-only
recovery. A running worker also checks durable authority before and after each pass and replaces its driver when a
system restriction appears. It cannot discover new cycles or submit entries while restricted. During the existing close window it can cancel outstanding
orders belonging to the bound cycle and submit the existing position-reducing close after fresh exact reconciliation.
The persisted kill state remains active, and broker identity, unknown-order, quantity, accounting, and close-deadline
checks still apply. Operator restrictions do not enter this recovery path. An operator hold replaces an existing
automatic restriction, and later automatic failures preserve the hold.
Once durable completion evidence is verified, the cycle may settle its restricted generation even when it had fills.
Native authority rollover still requires all intents to be terminal, fresh exact reconciliation, a flat account and
no unresolved mutations or open orders before creating a clear OBSERVE successor.
A resolved reconciliation discrepancy can also settle an idle generation with no acquired cycle under those same
accounting and flatness checks. A bound pending or active cycle keeps its existing generation while recovery manages
the position; it cannot attempt authority rollover until the cycle is terminal.
The existing activation path then verifies the grant before publishing the next execution driver. This transition
does not require a worker restart. An untouched, unbound cycle retains its plan until the session's entry cutoff,
including restrictions after market open. Its snapshot, decision and intent history must remain empty. Partially
bound cycles retain settlement handling. Migration 0071 repairs an already authority-blocked, untouched cycle only
before its cutoff, under the writer fence, with clear matching authority, exact reconciliation, flat positions and
no unresolved mutations or open orders. Manual restrictions and financial history remain protected.

Mutation preparation uses its verified durable decision and session binding plus fresh broker reconciliation. It does
not reread the market calendar after the decision is bound, so an unrelated calendar outage cannot prevent accepted
order recovery or the scheduled close. New decision construction still reads and verifies the broker calendar.
Each new entry risk decision retains its pricing quote event time and the snapshot's maximum quote age. Approval
expires at that event-time deadline or an earlier broker, intent, or session deadline. The final submit transaction
rechecks the persisted expiry after writer/grant locks and broker reads, so retries or worker restarts cannot extend
it. An expired entry follows the existing durable no-send path. Close-only recovery keeps its separate close lease.

Broker-session startup verifies account identity and permissions, account configuration, positions, orders, fills,
and order lookup access. It does not require the calendar endpoint, so an outage cannot prevent a replacement worker
from starting recovery of a bound decision.

Broker reconciliation recaptures changing history or lagging fill activities at most twice, 500 milliseconds apart,
before persisting a snapshot. A broker terminal fill may precede local acknowledged-intent recovery; recorded terminal
outcomes and aggregate fills still must agree. Equity marks from separate account and position observations remain
visible as valuation differences, while cash, inventory, cost basis, fees, and ledger reconciliation remain exact.
Flat accounts require exact equity agreement. Matching receipt timestamps do not make separate broker responses atomic.

## Runtime architecture

- `BaynExecutionController` is the only scheduler. Restate serializes handlers by canonical account-binding hash,
  persists timers and retries, and resumes after worker replacement.
- The execution worker runs one bounded `advanceExecutionOnce` pass per tick. Restate is not treated as broker
  exactly-once delivery; durable intents and deterministic IDs remain the external-side-effect boundary.
- PostgreSQL is the authoritative cycle, grant, intent, mutation, reconciliation, and controller-status ledger.
- Each writer transaction reserves its own PostgreSQL connection and holds the advisory fence through commit or
  rollback. A disconnected transaction fails without replaying its writes; the next pass obtains a usable connection
  and reconciles durable state. Nested fence calls stay in their owning transaction.
- Recovery recognizes a cycle that completes with verified terminal fills after a system failure restricts authority.
  It still requires fresh exact, flat reconciliation and the normal OBSERVE successor before reactivation. An operator
  kill remains restricted.
- PostgreSQL statements use a session limit below the smaller operation and reconciliation budget. The current
  30-second budget gives statements 25 seconds, reserving five seconds for cancellation and rollback. Smaller budgets
  reserve half their time. The client closes a connection with no network activity halfway through that remaining
  allowance (27.5 seconds for the current budget), so a lost response cannot leave transaction cleanup waiting forever.
  The aggregate execution deadline remains unchanged, and an uncertain mutation still requires durable lookup and reconciliation.
- Connection acquisition and transaction startup are cancellable, including when both pool connections are occupied
  or a BEGIN/fence-query acknowledgment is lost. Interrupted startup still rolls back before releasing its connection
  and writer permit. Commit and rollback retain their cleanup semantics. TigerBeetle requests have their own operation deadline;
  cancellation invalidates the transport and the next request creates its replacement without replaying a mutation.
- The pinned Effect PostgreSQL adapter has a package patch for interrupted reservations. It registers release ownership
  before requesting a pool slot and returns connections delivered after cancellation. The integration regression cancels
  two queued writers and verifies that both pool slots remain usable; proving only one subsequent query misses a one-slot leak.
- Stages record failures, interruption, and successful operations taking at least one second. The logs include stage,
  dependency where known, operation, elapsed time, and trace identity. Connection acquisition, transaction begin/commit/
  rollback, Alpaca reads, TigerBeetle requests, broker snapshot reads, and reconciliation persistence are distinguishable.
- A pass deadline records interruption request time and every active stage/dependency with elapsed time before joining
  cancellation. Nested deadlines share the pass's active-stage map; independent passes have separate maps. Its final warning separates
  `executionElapsedMs` from `cancellationElapsedMs`; `bayn.execution.timeout-recovery` and
  `bayn.execution.restriction-persistence` record their own completion durations. A timer that itself ran late remains
  visible in execution elapsed time. These measurements do not claim that an earlier uninstrumented stall had the same cause.
- A generation authority read gets at most one-sixth of the pass budget, capped at five seconds. Authority reads
  separately trace pool acquisition and query execution, and reuse the current transaction when one exists.
  Each reconciliation broker read gets at most one-third of the reconciliation budget, or ten seconds with the
  current configuration. The aggregate pass budget still bounds the full operation. Startup preflight keeps its own
  request and retry deadlines. Both broker-history captures remain mandatory.
- The dedicated Bayn PostgreSQL cluster logs statements exceeding one second and lock waits exceeding one second.
  `log_parameter_max_length=0` and `log_parameter_max_length_on_error=0` suppress parameter values. SQL statement text is
  still present in database logs. For a lock wait, correlate the PostgreSQL process ID, blocker ID, application name,
  and timestamp with Bayn's operation/trace interval; database process IDs are not trace IDs. A current read of
  `pg_stat_activity` with `pg_blocking_pids(pid)` distinguishes a lock from a running query. These diagnostic settings do
  not change replication, durability, volumes, or storage placement.
- The Bayn namespace log collector includes the CNPG postgres containers. Database pods do not inherit the
  application's part-of label, so discovery uses the namespace and explicit container names.
- TigerBeetle is the authoritative fee, cost-basis, cash, and realized-P&L ledger.
- Account reconciliation and forward-performance reads paginate the complete expected account history by TigerBeetle
  timestamp. Each request stays within the batch limit. Reads continue through short pages and request one additional
  record to detect unexpected history. Exact record identities, metadata, and aggregate balances remain mandatory;
  a malformed page or transport failure cannot produce an exact result. Individual posting batches and persisted
  simulation-run limits remain unchanged.
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

Dorvud's optional technical-indicator stream is joined as immutable decision evidence when
`BAYN_KAFKA_TECHNICAL_FEATURES_TOPIC` is configured. See the
[streaming contract](src/market-data/streaming/README.md#technical-indicator-evidence) for timing, readiness,
source matching, replay and delivery requirements.

Alpaca WebSocket events enter the existing raw Kafka topics. Each execution worker owns a complete
`@platformatic/kafka` projection for the 16-symbol core universe. Dorvud/Flink independently publishes rolling
features to `torghut.market-features.v1`; the archive retains raw and feature messages in ClickHouse. The six strategy
candidates and SPY benchmark remain unchanged. The public status service does not consume Kafka.

The worker joins a completed feature window to its exact raw bar revisions and independently fresh quotes/trades.
Corrections invalidate an old feature until its replacement matches. Missing candidates produce exclusions;
missing benchmark data or absence of every candidate makes the observation unavailable. Streaming failures never
silently switch to the archive path. Reconciliation and the existing close-window recovery remain available.

PostgreSQL commits the exact decision and pricing cuts with immutable source references before broker work proceeds.
Streaming evidence has a separate schema and carries no archive-watermark claim. Bayn owns no ClickHouse DDL or
backfill path. See [streaming operations and replay](src/market-data/streaming/README.md) for configuration,
recovery behavior, and evidence boundaries.

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

This migration retires the previous decision and market-data contracts. Before promotion, verify that no unfinished
cycle references a retired decision or snapshot and that broker orders, positions, and ledger balances reconcile.
If an earlier release still owns such work, let that release finish recovery before the cutover. Retain terminal
financial documents unchanged for audit; do not rewrite their hashes or restore legacy runtime decoders.

Do not deploy directly or submit a broker order manually. A code release does not change the sealed research request
or grant live capital authority.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: current dependency and execution-readiness projection.
- `GET /v1/status`: bounded controller, strategy, authority, cycle, reconciliation, accounting, build, and blocker
  state.

Controller `lastOutcome` distinguishes `Waiting`, `Completed`, and `Blocked`. `lastPass` retains the recovery action
and its readiness or lifecycle reason. `JEV_POSITION_HELD` identifies a reconciled position that remains open. Snapshot
waits retain the affected symbol, missing timestamp, required feature definition and window, or first available time when known.
Both `autonomousCycleLoop.lastPass` and `executionController.status.lastPass` expose these structured fields. Free-form
readiness and failure messages stay out of the public response. Historical pass observations without these details remain readable.
New tagged waiting observations require exactly one lifecycle reason or structured readiness detail. Pre-open,
mutation recovery backoff, pending broker intents, unavailable close data, and ordinary holding remain distinct.

Candidate observations are stored in the append-only `intraday_candidate_observations` table before inference proceeds.
Native content hashes bind the cycle, authority generation, protocol, snapshot manifest, raw rows, and reconciled
portfolio. Entry and management decisions additionally bind the completed inference batch. The corresponding log
contains that hash, candidate symbols, and source exclusions. A failed audit write fails the pass.

Execution latency metrics use separate clocks:

| Metric suffix (`bayn_cycle_…_latency_seconds`) | Start                        | End                           |
| ---------------------------------------------- | ---------------------------- | ----------------------------- |
| `intent_to_submit`                             | Intent creation              | `SUBMIT_STARTED`              |
| `order_acknowledgement`                        | `SUBMIT_STARTED`             | `SUBMIT_ACCEPTED`             |
| `order_observation`                            | Intent creation              | First local order observation |
| `intent_to_broker_fill`                        | Intent creation              | Broker fill source timestamp  |
| `fill`                                         | Intent creation              | Local fill observation        |
| `fill_ingestion`                               | Broker fill source timestamp | Local fill observation        |

Acknowledgement includes local pretransmission work after `SUBMIT_STARTED`; it is not the HTTP request duration.
It replaces the previous acknowledgement metric's intent-to-order-observation calculation. Recovery that finds an
order without a recorded acceptance does not invent an acknowledgement sample. Missing samples are omitted;
negative differences are excluded and counted in `bayn_cycle_latency_clock_regressions`.

Decision building can reuse a reconciliation completed by the same pass's preflight. The result does not survive
that pass, and submission preparation retains its separate reconciliation and final mutation-authority checks.

The read-only forward-performance command can isolate one durable mandate. Take the exact
`capitalActivation.generationHash` from `/v1/status` when `capitalActivation._tag` is `Realized`, and run it in the
configured runtime:

```sh
node dist/forward-performance-command.js --authority-generation <generation-hash>
```

Without that option, the command evaluates account history, which may span retired strategies and mandates.
The command emits `bayn.forward-performance-report.v1`. Its `receipt` contains the unchanged v3 financial receipt;
`positionEpisodes` measures completed entry-to-flat episodes separately from fill transactions, and `reportHash`
binds both. Native controller persistence still writes only the original v3 receipt. The analysis report never changes
an immutable per-generation receipt or requires mixed-version replicas to read a new stored field.
Research strategy identity follows the cycle's saved PAPER decision or execution intent generation. A cycle may be
created before its generation activates; its creation timestamp does not override that durable binding. Account,
research plan and protocol must still match, and an unbound cycle cannot establish a research strategy identity.
Malformed or ambiguous arguments fail before configuration or evidence reads. A generation-scoped receipt still
requires completed executions and exact accounting; operational readiness and an active research mandate do not
establish profitability.
Historical decisions that the current runtime cannot validate are listed by hash in `receipt.executionQuality.unverifiedDecisionHashes`.
Their accounting remains reportable, but any such decision leaves execution quality and capacity `UNDETERMINED`.
Native archive requests use durable intent symbols independently of decision validation; reporting cannot authorize an order.

Completed native intraday cycles bind performance evidence to `streaming_snapshot_references` or older
`intraday_snapshot_references`. Streaming receipts preserve the original input cut and content hash. Their retrospective
archive request retains every decision lineage offset and verifies that each precedes its consumed partition position.
The reader uses the
same universe, IEX feed and exchange calendar as the decision, with the complete regular-session window, a fixed
reconciliation cutoff, and captured Kafka partition offsets. Legacy daily SIP publications remain supported.
Native receipts retain the archive request, source hashes, recorded volume and missing minute timestamps. IEX
recorded participation does not establish consolidated liquidity or real execution capacity from PAPER fills.

A canceled or partially filled order's opportunity shortfall uses the observed finalized closing-minute bar, labeled
`FINAL_MINUTE_BAR_CLOSE`. Missing middle minutes leave full-session participation `UNDETERMINED` while retaining a
valid closing reference and execution measurement. A missing closing bar cannot supply that reference. Reporting
never manufactures bars or changes the decision snapshot's entry freshness rules.

A standing mandate's next scheduled cycle does not make the reconciled performance window incomplete while its
submission window is still in the future and it has no durable decision or intent. Blocked cycles, started cycles,
and any future cycle with durable execution work still prevent a sufficient receipt.

## Replay and backtesting

For a development comparison of retained Jev entry signals against fixed deterministic rules, use the
[signal study command](../../docs/bayn/jev-signal-study.md). It verifies the original source and measures common
15-minute hypothetical outcomes. It is a signal screen, and its overlapping hypotheses do not form a portfolio
backtest or satisfy the migration's economic acceptance protocol.

The separate [control portfolio command](../../docs/bayn/control-portfolios.md) evaluates full-session deterministic
development portfolios with independent cash and positions, repeated entries, partial exits, and shared execution
accounting. Its mechanical management and declared latency scenarios require further matching before acceptance.

Production execution and simulation use `makeTradingEngine`. The engine constructs the execution program and
recovery-first cycle driver from one strategy and risk policy. The broker, market-data source, clock, and isolated
persistence are environment bindings. Replay does not implement its own strategy selection, sizing, order planning,
or accounting coordinator.

`backtest-command.js` runs one or more consecutive exchange-calendar sessions through that engine. One simulated
broker, account, portfolio, PostgreSQL database, and TigerBeetle ledger span the entire run. Cash, positions, fees,
risk history, and unresolved orders are retained between sessions. The command rejects duplicate session dates,
missing calendar entries, and skipped intervening sessions. Separate experiments use separate run identities and
fresh databases.

```sh
bun run --filter @proompteng/bayn build
BAYN_BACKTEST_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:5432/bayn_replay \
BAYN_BACKTEST_TIGERBEETLE_ADDRESS=127.0.0.1:53000 \
BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID=20912 \
BAYN_BACKTEST_TIGERBEETLE_LEDGER=70912 \
node services/bayn/dist/backtest-command.js \
  --input backtest.json --arrivals source.ndjson.gz \
  --source-receipt source-receipt.json --source-receipt-sha256 "$SOURCE_RECEIPT_SHA256" --output new-run-directory
```

The input is `bayn.backtest.v3` in `src/intraday-replay/backtest.ts`. It binds `sessionDates`, the full calendar,
source manifest, native Jev build and strategy identities, opening cash, asset metadata, execution assumptions,
controller cadence, and cost assumptions. Retired momentum backtest inputs cannot start the native runtime.
Historical artifacts remain available for comparison and audit.

Set `BAYN_JEV_API_KEY` through the existing protected environment. The command requires an
`inference` object with `mode: "measured-provider"`, `model: "jev-1.13.0"`, and
`inputDefinition: "bayn.jev-trading-signal-state.v2"`. Its `costs` object contains
`inputMicrosPerMillionTokens` and `outputMicrosPerMillionTokens` as integer strings. The input also declares
`allocatedDataCostPerSessionMicros`. Changing these assumptions changes the run identity.

The provider uses an independent live clock. Replay retains original provider requests, responses and timestamps
in `jev-calls.ndjson` before advancing market and database time. Concurrent calls share elapsed time. Native
PostgreSQL batch and evaluation stores retain the mapped evidence and enforce the original inference deadline.
Failed or interrupted calls with unresolved charges make the cost result incomplete. Known charges use the declared
tariff with each call rounded upward to one micro-dollar. Invoice verification remains required for qualification.

This local replay command connects directly to TypeSafe through Node HTTP. Production inference uses the dedicated
CONNECT proxy. Development replay latency therefore includes the local host and network path; it does not prove
production proxy latency or connectivity. Record that transport difference with the run and measure the deployed
path before claiming production timing parity.

Final authorization samples measured elapsed time after provider, persistence, writer-lock, grant and broker reads.
Every replay reconciliation, including those inside the cycle driver, uses that measured clock after ingestion.
During measured operations, the replay account's transaction-acceptance clock advances with PostgreSQL wall time,
including evidence queries, insertions and work in the enclosing transaction. Recorded observation timestamps retain
their synchronized replay time. Reconciliation returns that published source timestamp; it cannot stamp evidence
ahead of the account and market-data clocks. Time spent publishing arrivals is retained for the next synchronization
and the measured scope's completion. Pausing measurement retains elapsed time and advances the market clock. The
runtime then consumes arrivals through that timestamp before returning to scheduling or valuation. Deferred
exit deadlines therefore see time spent before transaction acceptance.
Bootstrap advances the persisted account clock after reconciliation before activating its capital grant.
Initialization starts one minute before the first registered open and retains its measured start, completion and
elapsed time in the report. If initialization misses that open, the run fails without rewinding or omitting opening
coverage. The scheduled session boundaries remain the supplied calendar's open and close.
This preserves causal ordering between broker observations and their reconciliation; a partial IOC entry can finish
after its exit and fresh exact-flat evidence. Clock failures remain explicit and cannot produce a successful receipt.
Risk expiry and the submission lease use the same final timestamp. Controlled regressions reject expired evidence
without a broker submission, including time spent advancing retained replay data. Full lifecycle simulation must
also prove arrival-time pricing, position management, exact-flat completion and fresh reentry. These timing tests
do not establish economic performance.

Replay uses the production generation driver for restricted-cycle settlement, exact-flat reconciliation and
reactivation. A blocked cycle may re-enter after the existing delay only when its immutable decision belongs to
an earlier generation; a block in the current generation remains terminal. Restart preserves the recovered grant,
and operator restrictions remain held. Session-close valuation selects the most recent retained quote that was
available at close, even when a later arrival has replaced the projection's current quote.

The broker calendar must include the next trading session after the final replay date. The production scheduler
selects that successor after finishing its last position; omitting it is an input error even when all requested market
hours have data. Retain the actual Alpaca calendar response, including holidays and early closes. The export's
`calendar.json` lists the selected data sessions; extend the backtest calendar with verified broker calendar context.
The successor supplies scheduling context only and does not add a replay session or require market events for that day.

Every input uses `bayn.backtest-source.v1`, a complete source file, and a separately pinned source receipt. Captured Kafka and historical REST declare different transport provenance. Hashes, source
coordinates, partition inventory, record ordering, and coverage must validate before database setup. Capture receipts
establish the retained stream's bounds; they do not establish historical liquidity or original delivery for REST data.
See the [streaming guide](src/market-data/streaming/README.md) for source capture and Dorvud feature regeneration.

Each pass records the engine's decision/cycle result and simulated broker state. Entry and position-management waits
retain typed readiness: pending, rejected or expired inference and unavailable market inputs count as missing decision
data, even when a later deterministic exit succeeds. A verified model hold remains distinct from unavailable evidence.
The final `bayn.backtest-report.v2`
retains every session's schedule, closing broker equity, net equity after known model and allocated data costs,
and reconciliation, plus cumulative net equity change, observed peak
and drawdown, final broker orders/fills/positions, durable accounting counts, and input identities. The output keeps
the exact input, source receipt, pass log, decoded entry and closing decisions, accounting rows with full integer precision, and hashes. Valuations retain the last observed valid bid and its age; that accounting mark never relaxes executable-quote freshness. Preserve the source file and both databases with the report.

Simulation accounts are isolated from production. The command cannot acquire Alpaca trading credentials, target a
remote production database, overwrite a populated replay database, or change capital authority. Missing data,
failed passes, unresolved orders/positions, or accounting mismatches remain visible and prevent acceptance.
Repeated simulated orders consume each quote's declared displayed-liquidity budget once per symbol and side; a new
quote identity starts a new budget. Checkpoint restoration replays the same consumption before accepting fills.
The session schedule counts unavailable required decision observations separately from successful no-trade and
expected lifecycle waits. Failed or expired entry inference is unavailable decision data even when its token usage
can be fully priced. Only a complete valid decision can report no eligible candidate. Close-only market sells support
fractional liquidation with fresh, sufficient arrival
liquidity; an unsupported market remainder fails the simulation. See the streaming guide's
[close and coverage acceptance](src/market-data/streaming/README.md#replay-close-and-coverage-acceptance). Negative
returns are valid measurements. Reconciled simulated results do not establish profitability or calibrate broker fills.

## Historical data workflow

`bun run --filter @proompteng/bayn history --input job.json` is the single offline data tool. Its four operations
prepare inputs for the same backtest command. It is excluded from the service build and image; deployed Bayn keeps
read-only ClickHouse access. See `tools/history.ts` for the strict job schema.

1. **Acquire:** provide `operation: "acquire"`, `outputDirectory`, and `request` with
   `schemaVersion: "bayn.alpaca-backfill.v1"`, `startDate`, `endDate`, `symbols`, and `executionSessions`.
   `BAYN_ALPACA_KEY_ID` and `BAYN_ALPACA_SECRET_KEY` use the existing integration. The tool requests raw IEX minute
   bars for every completed broker-calendar session and quotes/trades for each execution session. It follows all
   pagination, caches original response bytes and receipts, and resumes identical requests. Quote and trade queries
   use disjoint windows of at most one hour, with the inclusive end set to the final nanosecond before the next
   window. Coverage combines those windows per symbol and session. This bounds the capture size before canonical
   hashing and JSON retention. Changed requests require a new immutable dataset. Missing minutes remain missing and
   appear in per-symbol/session coverage.
2. **Publish:** provide `operation: "publish"`, `datasetDirectory`, pinned `datasetId`, and `receiptPath`.
   Configure `BAYN_HISTORY_CLICKHOUSE_URL`, `BAYN_HISTORY_CLICKHOUSE_USERNAME`, and
   `BAYN_HISTORY_CLICKHOUSE_PASSWORD` for the existing offline data administrator. The GitOps schema hook must have
   created the historical tables first. Publication and restoration read records in batches of up to 50,000 rows.
   The publisher inserts only missing records, verifies complete row readback, then publishes the manifest. Restarting
   the same job rechecks existing rows and resumes missing inserts, including an interrupted batch. Conflicting
   records stop publication. It never creates tables or changes permissions.
3. **Restore:** provide `operation: "restore"`, pinned `datasetId`, and `outputDirectory`, using the same explicit
   ClickHouse configuration. Restoration reconstructs identical normalized chunks, calendar, coverage, and manifest;
   every checksum must match. Original HTTP page bodies remain at the acquisition destination. Preserve that archive
   with its provenance receipts.
4. **Export:** provide `operation: "export"`, `datasetDirectory`, `outputDirectory`, `featureJar`, and `request` with
   `schemaVersion: "bayn.alpaca-history-export.v1"`, pinned `datasetId`, consecutive `sessionDates`, canonical
   `universe` (including raw, rolling, and technical topics), `rawDeliveryDelayMs`, `barFinalizationDelayMs`,
   `featureProcessingDelayMs`, exact `featureProducerRevision`, and `featureJarSha256`.
   Build the jar using Dorvud's `:technical-analysis-flink:uberJar` task. Export requires acquisition coverage for bars,
   quotes, and trades for every selected dataset symbol/session. It generates both feature families through the
   production Dorvud transitions, writes `source.json`, `source-receipt.json`, `arrivals.ndjson.gz`, calendar and coverage,
   and reports the receipt's SHA-256. Use these with the canonical backtest input and command above.

REST export receipts explicitly list acquired symbols and unacquired strategy candidates. The strategy universe is
the routing and evaluation contract; it does not claim complete acquisition. Missing candidates remain excluded with
zero weight. A result from the seven-symbol dataset must not be described as a full-universe strategy comparison.
Finalized bars become available after minute completion plus both the configured finalization and raw delivery delays.
Simulation fees round separately for each New York session while account cash and positions carry across sessions.

Historical tables retain dataset versions without the live archive TTL. Each row carries dataset/query identity,
provider, feed, event time, and retrieval time. REST is explicitly `REST_AS_OF_RETRIEVAL` and original stream
availability is `NOT_OBSERVED`; a REST response cannot reproduce updates that were unavailable at its historical time.
The adapter assigns modeled availability and virtual coordinates. It excludes records outside the half-open regular
session, releases minute bars after their completion, and retains actual Dorvud computation time separately from
modeled delivery. Temporary exports use bounded streaming and compression; final source bytes are pinned before
execution. No REST operation publishes fake capture receipts or writes historical data into live Kafka topics.

For the seven-symbol research dataset, request AAPL, AMZN, IWM, NVDA, QQQ, SMH, and SPY from 2024 onward. Bars alone
are useful retained history; they are insufficient for quote-based execution tests. Expand `executionSessions` when
additional full execution windows are needed, preserving the earlier dataset version and results.

## Validation

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn test:postgres
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn lint:oxlint
bun run --filter @proompteng/bayn build
```

PostgreSQL tests require an isolated database whose name ends in `_test`; never point them at a live Bayn database.

The optional cumulative-ledger integration test requires an isolated TigerBeetle 0.17.9 server on loopback with cluster
ID `2001`. It posts 10,500 synthetic transfers, verifies account and performance evidence, and supports rerunning against
the same data after restarting the server. Run it from the repository root:

```sh
BAYN_TEST_TIGERBEETLE_ADDRESS=127.0.0.1:39701 bun test services/bayn/src/ledger/account-history.test.ts
```

Historical development candidates are terminal, non-executable records summarized in
[`docs/bayn/candidate-terminal-history.md`](../../docs/bayn/candidate-terminal-history.md).
