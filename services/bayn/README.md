# Bayn

Bayn is a single-writer trading service. Restate schedules one account-keyed controller; pure TypeScript decides
what should happen; Effect runs bounded, cancellable work; PostgreSQL stores execution truth; TigerBeetle stores
accounting truth; and the broker adapter performs authorized execution.

Current entry scope is **equity-only**. Retained crypto positions keep protection, risk-reducing exits,
reconciliation and accounting. The scope is enforced by
[`currentEntryMarkets`](src/execution/trading-scope.ts), independently of the broader retained mandate.

## Start here

| Task                                          | Reference                                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Understand current entries, pricing and exits | [Active strategy](#active-strategy), [strategy protection](../../docs/bayn/strategy-protection.md)                                              |
| Change execution or recovery                  | [Execution contract](#execution-contract), [runtime architecture](#runtime-architecture)                                                        |
| Trace broker captures, freshness or quota     | [Broker observation owner](#broker-observation-owner), [Valkey materializations](#required-valkey-broker-materializations)                      |
| Inspect source availability                   | [Market data](#market-data), [Webull ingestion](#webull-live-ingestion), [streaming guide](src/market-data/streaming/README.md)                 |
| Operate or release Bayn                       | [Operations](#operations), [delivery](#delivery), [cycle runbook](../../docs/runbooks/bayn-cycle-operations.md)                                 |
| Read status or diagnose an outage             | [Endpoints](#endpoints), [cache runbook](../../docs/runbooks/bayn-cache-observability.md)                                                       |
| Evaluate economics or a proposed strategy     | [Profitability goal](#profitability-goal), [replay and backtesting](#replay-and-backtesting), [research](#independent-jev-instruction-research) |
| Build and validate a change                   | [Package scripts](package.json), [validation](#validation), [service guide](AGENTS.md)                                                          |

## Core contracts

- **Evidence precedes action.** Entries require verified source identity, completed bars, current quotes and complete
  inference evidence within the original deadlines. Candidate exclusions stay explicit; they never become invented
  bars, zero-cost requests or successful decisions.
- **Authority is separate from readiness and research.** Execution requires the exact durable account, source,
  image, strategy and risk-policy grant within the configured capability ceilings. A healthy pod, reconciled ledger,
  model judgment, research result or promoted image grants no capital authority.
- **One writer owns mutations.** Intent identities and mutation reservations commit under the account writer fence
  before broker I/O. Uncertain outcomes go through deterministic lookup and exact reconciliation before new exposure.
- **Accounting is durable and exact.** PostgreSQL evidence and TigerBeetle records must reproduce the expected
  identities, quantities, costs, fees and balances. Retained financial codecs and migrations preserve historical
  bytes and hashes. Unsupported historical execution evidence stays explicitly unknown.
- **Recovery precedes new entries.** Bound positions, unsettled orders and unresolved mutations keep their recovery
  owner. Operator holds remain held. Daily loss, cumulative drawdown and gross-turnover history survive worker,
  policy and strategy changes.
- **Costs and qualification stay explicit.** Known execution and operating costs are deducted; missing costs remain
  unknown. Prospective economic acceptance and operational reliability use their registered evidence contracts.

Current inference uses protocol v40, numerical input v24, batch v8, entry input v8 and handoff v5 with pinned
`jev-1.14.0`. The [Jev 1.14 cutover](../../docs/bayn/jev114-box-cutover.md) describes the authority and retained-evidence
transition. The [pre-chart feasibility contract](../../docs/bayn/pre-chart-feasibility.md) explains which impossible
source proposals can be rejected before paid inference.

This guide describes current source behavior. Historical implementation notes remain in the
[pre-cleanup revision](https://github.com/proompteng/lab/blob/ce24661870dd490c1fac592227f77027f7c6ddab/services/bayn/README.md);
earlier activation recipes remain in the
[prior guide](https://github.com/proompteng/lab/blob/55f1aad1e416e03ba4c3a7b9ce14ab2a20b7c4fc/services/bayn/README.md).
The [October 17 investigation](../../docs/bayn/crypto-entry-research-2026-10-17.md) retains its reproduction and cost
evidence. Historical recipes and measurements do not establish current deployment, authority or profitable edge.

## Webull live ingestion

`BAYN_KAFKA_WEBULL_BARS_TOPIC=dorvud.webull.raw.v1` adds native Webull captures to the existing equity Kafka
consumer. The controller records completed M1 context in its immutable streaming snapshots. It does not query
ClickHouse on this path. HTTP bars, MQTT messages and collector gaps retain their original identities. MQTT
messages do not become bars or executable quotes.

The consumer checks the native payload hash, exact decimal OHLCV, real-time entitlement marker, requested symbols,
completed recovery window and producer clock. Only the latest completed minute is eligible. Its first consumer
arrival must be within ten seconds of minute close and before the observation. Recovery polls cannot refresh that
arrival; a late correction removes the current minute until a subsequent eligible observation. Scoped bar gaps and
invalid captures withhold optional context without invalidating IEX inputs. Missing symbols remain explicit.
Candidate snapshots retain independent Webull observations for IEX-excluded candidates so coverage comparisons
include those cases. Their original IEX exclusions still prevent signal construction and trading.

Snapshots retain each selected capture once, with native bytes, Kafka coordinate, consumer sequence and arrival.
Recorded replay verifies that proof again. `Kafka Webull minute bars incorporated` logs measure the real consumer
arrival delay, including late inputs. The existing streaming diagnostics command also reports Webull coverage.
Historical diagnostic reads establish arrival at the diagnostic consumer only, not availability to an earlier decision.

Producer-clock rejections include validated collector receipt and Kafka timestamps, their signed difference,
the permitted 5,000 ms difference and the observed ordering. These diagnostics do not attribute a queue or clock
cause. The existing clock bound, independent ten-second first-arrival cutoff and context withholding remain enforced.

Current candidates carry `webullContext` in numerical input v24 and final proposal evidence v2. It contains one independently
labeled completed M1 bar for the candidate, with exact native decimal strings and original receipt timing. The
existing snapshot proof supplies it; no new query or service runs on the decision path. Jev questions explicitly
consider this supplemental observation. Unavailable context is `null`. IEX remains the chart, execution-price and
liquidity source, and its original candidate exclusions still apply. Nasdaq Basic and IEX retain separate prices
and volume. Activation follows the current [Jev 1.14 cutover](../../docs/bayn/jev114-box-cutover.md) and reviewed mandate procedure.
The acceptance boundary is a deployed consumer receipt, regular-session completeness and latency measurements, then
a comparison against IEX using recorded availability. Better returns require separate economic evidence.

## Webull archive comparison

`bayn-webull-research` reads the normalized Webull archive and compares completed M1 bars with the current Alpaca
IEX archive. It is a read-only research/scanner input. Reports remain `UNQUALIFIED`; the command has no broker,
model, order or capital capability. It uses the existing `BAYN_CLICKHOUSE_URL`, `BAYN_CLICKHOUSE_USERNAME` and
`BAYN_CLICKHOUSE_PASSWORD`. The existing `bayn` user needs SELECT on the projected
`signal.webull_research_events_v1` view, which excludes native payload bytes.

Build with `bun run --filter @proompteng/bayn build:research`, then run
`bun run --filter @proompteng/bayn webull:research --input input.json --output new-report.json`.
The production image also provides `bayn-webull-research`.

```json
{
  "startAt": "2026-11-03T14:30:00.000Z",
  "durationMinutes": 30,
  "evidenceAsOf": "2026-11-03T15:00:10.000Z",
  "selection": { "kind": "symbols", "symbols": ["AAPL", "NVDA", "SPY"] }
}
```

Use `"selection": { "kind": "catalog" }` for all symbols represented in captured requests. A five-minute catalog
window fits a full supported sweep; narrow longer windows if any query exceeds 100,000 rows. The command fails on
truncation, malformed rows, future windows or query timeout and refuses to overwrite output. Windows are minute-aligned,
1–360 minutes, and bounded by collector receipt as well as completed bar time. Optional `evidenceAsOf` sets a separate
receipt cutoff for both feeds, from window end through six minutes after it; it defaults to window end and cannot be
in the future. The report hashes its content and
retains exact decimal OHLCV, receipt/archive nanoseconds, payload hashes, UUIDs and Kafka coordinates. Recovery repeats
collapse by provider/feed/symbol/minute/session, retaining the latest received revision and its observation count. Counts include repeated recovery responses or Kafka publications.

Research report v2 also retains the earliest valid collector receipt and its capture UUID, payload hash and Kafka
coordinate separately from the latest revision. Per-symbol and total `collectorTiming` counts compare that first
receipt with minute close using the same inclusive ten-second budget as live context. The comparison retains
nanosecond precision at the boundary, and repeated recovery polls cannot improve a minute's original timing.
The report retains every requested symbol/minute slot. Only slots whose full ten-second budget has elapsed by
`evidenceAsOf` enter the eligible denominator: late, missing and conflicting minutes remain explicit. Other slots
remain `pendingMinutes`, separately from missing data. The default cutoff leaves the final minute pending; using
window end plus ten seconds closes that budget without changing the completed-bar window.
Closed or inactive periods still occupy slots; this diagnostic does not infer a market calendar or expected trades.
Catalog selection covers only captured symbols. Collector timing is a necessary upstream measurement, not evidence
of actual Bayn consumer availability; a timely collector receipt can still reach the consumer too late. The retained
first receipt can precede a later price correction and does not qualify that correction's availability.

Coverage keeps `EMPTY`, `EXCLUDED`, `OMITTED`, `REJECTED` and missing-request states explicit. Freshness is measured
from bar start with a six-minute budget; an empty response does not establish a fresh bar. Gap captures remain in the
report. The captured request catalog does not prove that every listed symbol is entitled or has traded. Existing raw
rows written before normalization have empty normalized arrays until an explicit, provenance-preserving replay.

Comparisons match symbol and UTC minute while retaining Webull Nasdaq Basic and Alpaca IEX labels, sessions and
provenance. Webull decimal text stays exact; Alpaca's existing archive stores Float64, and the report states that
precision difference. Price and volume differences can reflect venue coverage. Missing sides remain explicit.
This is a current retained-archive research export with a collector-receipt cutoff; it cannot establish what Bayn
could have read historically and cannot serve as a qualified backtest or live decision snapshot.

## Profitability goal

**Produce repeatable positive profit after all costs, within the registered risk limits, using the smallest
understandable system that meets its original deadlines and reliability requirements.**

The [October 6, 2026 research review](../../docs/bayn/recent-strategy-research-2026-10-06.md) compares recent candidate papers, their data vintages, execution assumptions, and fit with Bayn. Its shortlist is research context and grants no qualification or capital authority.

The [November 7 paper-edge campaign](../../docs/bayn/paper-edge-research-2026-11-07.md) starts with exact-source CosmosAlpha reproduction and examines new factor-search and wallet-flow mechanisms. Its reference design does not register a prospective economic period or authorize a strategy change.

Demonstrate repeatable positive net profit after execution, inference, data, infrastructure, and research costs on
untouched prospective sessions. The active [TypeScript acceptance policy](src/jev/acceptance.ts) requires positive
fully costed profit and positive absolute and paired lower bounds over the exact registered calendar. It has no
fixed session count, activity or turnover quota, dollar profit hurdle, control-profit multiple, or mandatory stress
scenario. Allocation and loss limits come from the registered source-approved risk policy. Current qualification
uses conditional Hoeffding bounds with prospectively registered policy supports and matched controls. The causal
filtration, conditional mean model and bounded-support assumptions must be fixed before the first open; observed
returns cannot establish those assumptions. Retained assessments reproduce their original statistical methods.
Operational reliability remains 99.9% independently for eligible classes, with zero safety violations and complete
realistic evidence. An assessment grants no capital authority.
See [current and retained acceptance rules](../../docs/bayn/jev-migration-validation.md#economic-acceptance).
Historical contracts and assessment receipts retain their original terms and hashes; prospective attempt numbering
continues across the policy change.

Profit is the outcome; correctness and reliability are acceptance requirements. Engineering work serves that goal:

- **Performance:** measure quote receipt through decision and broker acknowledgement, including p50, p95 and p99
  latency, original-deadline misses, CPU, memory and database work under representative load. Count scheduled work
  that never starts. Retain the original freshness, admission, inference, submission and recovery deadlines.
- **Simplicity:** keep one owner for each mutable fact and one authoritative representation at each trust boundary.
  Remove redundant work and replaced paths while preserving required validation, durable evidence and authority
  rechecks. Add abstractions, dependencies or configuration only for a demonstrated current requirement.
- **Functional code:** keep deterministic domain decisions pure and immutable, with plain values for total code and
  explicit validation failures. Use Effect for typed I/O, bounded concurrency, cancellation and scoped resources,
  following the [service guide](AGENTS.md). Make state transitions and failure behavior directly traceable.
- **Change acceptance:** state the concrete problem, establish a representative baseline, make the smallest coherent
  change and verify its effect and relevant failure paths. Preserve bytes, hashes and accounting contracts when
  optimizing. Report microbenchmark gains separately from end-to-end and economic results; retain inconclusive work
  as inconclusive. Freeze strategy changes before their untouched prospective comparison.

The immediate priorities are reliable recovery and complete cost accounting, then the existing
[`matched-entry study`](../../docs/bayn/matched-entry-study.md) to test Jev's incremental value under common timing,
sizing, and exits. Historical trades are development evidence. A selected confidence score, a positive day, or an
engineering improvement cannot complete economic qualification. Freeze any candidate revision and its cost and
execution assumptions before its next untouched evaluation; retain failed and inconclusive attempts. Preserve the
current broker, capital, and risk limits throughout this work.

The [retained session export](../../docs/bayn/study-evidence-export.md) supplies complete native Jev observations,
plans and results for these diagnostics through a bounded read-only command. It retains exclusions, abstentions,
pending results and no-batch cycles; its receipt explicitly remains unqualified.
The [net-edge research notes](../../docs/bayn/net-edge-research.md) connect the current feed, model and execution
assumptions to primary research and define which hypotheses still require an untouched economic experiment.

The offline [equity edge screen](../../docs/bayn/equity-edge-screen.md) compares thirteen fixed bar-based hypotheses
under chronological partitions, native fee scenarios and serial capital accounting. It retains rejected trials and
missing coverage, never promotes a strategy, and does not substitute historical bars for original arrival/quote evidence.
Run it only in a separate research process; it is not part of the live service or its strategy selection.

## Internal APIs

Internal functions use a single data-first calling convention. The execution worker uses the recovering native runtime
adapter, and its tests exercise that same adapter. The current execution model is defined directly in
`src/strategy/intraday-market.ts`. Historical wire decoders and the daily snapshot readers remain available for
retained financial evidence; they do not select a live strategy or create current execution authority.

Streaming and simulated snapshot replay strictly parses the supplied manifest and fully reconstructs its source
rows and original cut. It hashes all supplied non-identity fields once against the reconstructed content commitment,
then checks both supplied identities against the reconstructed content hash and snapshot ID. The reconstructed
commitment already covers every nested cut field; repeated subtree and whole-manifest hashes are unnecessary.
Direct replay also binds the complete supplied metadata. Nothing is cached across calls or accepted merely because
its self-reported hashes are internally consistent. This reduces verification work without establishing a complete
generation report's latency budget or economic qualification.

## Runtime and research images

`bayn` contains status, execution, activation, projection and operating diagnostics. It retains the private
`bayn-forward-performance` financial report. Its replay executable and compiler-dependency receipt also remain
in the trading artifact: candidate qualification verifies them against the actual trading image digest.
`bayn-control-opening` also stays in the trading artifact. Opening capture verifies the deployed candidate's
embedded build, capital request and frozen plan; it cannot run under a research image identity.
`bayn-research` contains the research server, GEPA, replay and study
commands, frozen-control compiler receipts, Python, Git, Bun and Crane. The research artifact also owns
`bayn-system-assessment`; `--system-*` qualification flags are removed from the financial-report command.
Both artifacts must pass native architecture builds and publish successful receipts from the same source and CI run
before Kargo can promote either workload. Their existing credentials and network policies remain separate.

## Reproducible image dependencies

The Bayn Nix dependency build normalizes the two CLI symlinks in the
`browserslist` / `update-browserslist-db` dependency cycle before verifying its fixed-output hash.
Bun's isolated installer can omit these links in otherwise identical locked installs. Normalization preserves
package contents, rejects unexpected links or missing targets, and is idempotent. The dependency-input CI check
exercises all four link-presence combinations; both native image builds still verify their exact dependency hashes.

## Risk-query performance

Migration 117 indexes the native New York session-opening and historical peak-equity queries. Both retain their
original account, observation cutoff and deterministic ordering. They do not replace financial evidence with a cache,
rewrite valuations, reset a session loss or change any capital limit. Executed-plan regression checks include foreign
accounts, future marks, equal-time marks and both daylight-saving transitions. Reconciliation phase spans separate
fee posting, accounting verification, comparison, recording and risk-context reads from transaction commit time.

## Required Valkey broker materializations

Bayn uses Effect's native `@effect/platform-node/NodeRedis` binding for authenticated
TLS connections. The API and execution worker require the connection ConfigMap,
password Secret and client certificate at startup. The small `ValkeyCache` adapter
adds the `bayn:` namespace, bounded values and expiry, command cancellation and
replica acknowledgement. Scope exit destroys outstanding socket work before the
native binding closes its client.

Initial acquisition retries a native `ECONNREFUSED` failure at most twice, one second
apart, closing each failed acquisition before the next attempt. Authentication,
TLS, configuration and timeout failures fail immediately. The retry boundary ends
before the cache service is exposed, so it never replays a caller's command.
Each acquisition has a two-second budget covering TCP, TLS and the RESP handshake.
Cancellation aborts the native connection and awaits its settlement before closing
the layer scope. Healthy idle connections have no socket inactivity timeout or
periodic ping; the existing one-second command deadline detects stalled work.

Each command owns that connection through reconnect, its request, and cancellation;
`SET` and its replica `WAIT` stay together. Observation publication pipelines its
bounded pair of immutable payloads under one connection owner, then acknowledges
both writes with one replication barrier before publishing their database references.
Neither write is replayed after a failure or cancellation. Queued commands retain the one-second
deadline, and interrupting a queued caller does not close an active caller's socket.
Reconnect happens on the next command rather than in a competing background retry.
Replica acknowledgement uses 250 ms waits on the owned connection for the remaining
one-second command budget, without repeating `SET`. Missing acknowledgement at that
deadline cancels the outstanding work and fails publication. A deadline after a
negative acknowledgement retains that replication failure as its cause.

The pinned Redis client patch gives each connection attempt a native TCP/TLS
abort signal. Scope closure or command cancellation closes a socket that is still
connecting, and a cancelled attempt can only tear down its own socket. A caller's
abort signal remains active alongside this ownership signal.

Publication-failure logs report only allowlisted dependency, operation, failure-category
and cause-category fields. An operation deadline remains distinct from a previously
observed missing replica acknowledgement; the latter does not identify a later stall's cause.
Verified native timeout/socket-close errors have their own categories. Other command
failures use `command_failed`; unrecognized publication metadata uses `unknown`.
Raw causes stay attached internally and are not included in this publication log.
This does not change the native NodeRedis dependency's separate logging behavior.

The broker observation owner publishes an immutable full snapshot and compact
state in Valkey. PostgreSQL `broker_observations` stores their content hashes and
the generation, quota and mutation fences. Migration 98 removes its JSONB payload.
Reconciliation reads full history. Health, account, position, configuration,
recent-history probes and final submission preflight read compact state. Every read
rechecks PostgreSQL fences, account binding, original times and content identity.
Missing, expired, corrupt or unavailable Valkey data fails explicitly. There is no
PostgreSQL payload fallback or cache-disable mode.

A retryable snapshot rejection or read timeout discards the cut and its retained history,
then waits for the existing quota boundary before polling again. The already verified
broker session stays open, so transient fill convergence does not repeat startup preflight.
Failed acquisition, account or permission rejection, defects and external interruption
still dispose the session before recovery. Failed publication remains unavailable.
Market-calendar HTTP reads share a five-second budget across headers, body and retries,
or the configured operation deadline when shorter, leaving time for the bounded recovery pass.

`bun run valkey:verify` exercises authenticated writes, replica acknowledgement,
reads, deletion and expiry. Add `--broker` to verify the actual fenced broker
materializations and collect 20 samples of full and compact read latency and
payload size. The command is read-only against PostgreSQL and prints no account
values. See the [migration and performance evidence](../../docs/bayn/valkey-caching-plan.md).

The [cache observability runbook](../../docs/runbooks/bayn-cache-observability.md) covers native cache and database
operation histograms, separate SET/replica acknowledgement timings, payload sizes, collected server logs, index
catalog evidence, dashboard panels and alerts. The API reuses its existing metrics scrape; execution workers export
native Effect metrics to the existing Mimir gateway. The runbook includes a read-only rollout acceptance command.

## Broker observation owner

Stable history compares broker order facts before and after the account read. It excludes
the local `observedAt` timestamp on both parent orders and bracket children, because each
HTTP read assigns a new timestamp. Child execution facts, including status, prices,
filled quantity and submission time, still invalidate a changed snapshot.

Alpaca's nested order history counts bracket children toward the requested page limit.
Pagination counts both parent rows and their children before deciding that history is complete.
A page containing 498 parents and two children therefore continues to older orders at a 500-order limit.

Broker position symbols must agree with their asset class before entering
reconciliation. A canonical crypto pair labeled as an equity, or an equity symbol
labeled as crypto, fails the read contract without changing the original response evidence.

Broker capture preserves typed read and session-acquisition failures across its managed runtime boundary. Poll
warnings retain operation, failure kind, retryability and HTTP status without response payloads. A failed cut
discards retained history. Retryable read failures keep an already verified session for the next quota-paced poll;
acquisition failures, permission failures, defects and interruption dispose its scoped runtime before settlement.
Defects and interruption retain their original failure semantics.

Failed-capture warnings also emit the fixed `broker.poll_failure_reason`: acquisition deadline,
poll deadline, snapshot rejected, or unknown. The acquisition deadline covers the outer runtime,
including lazy acquisition and capture; it does not identify which stage was slow. Snapshot rejection
includes unstable history; the existing broad `TIMEOUT` kind alone does not establish a network timeout. This diagnostic
reads only allowlisted data fields from the direct typed reconciliation cause, never messages,
accessors, payloads or recursively nested causes. Snapshot failures additionally report
`broker.snapshot_failure_reason`. Fill convergence failures describe only the first rejected
member: no matching fill activities, summed fills below or above the order quantity, order versus
nested leg, and fixed broker order status. These are mismatch observations, not proof of provider
lag or a root cause; no identifiers, symbols, amounts or quantities are logged. History-change
rejection still precedes fill comparison, and no rejected cut is published. These diagnostics do not change admission, retry, quota,
mutation, clock, source-revision or authority fences.

`BaynBrokerObservations` is an independent, account-keyed Restate Virtual Object. Only its authenticated `notify`
ingress is public; activation, capture, completeness timers and status are private. Its exclusive handlers capture
without overlap and publish full and compact snapshots in Valkey before committing their fenced
references in PostgreSQL `broker_observations`. Execution and status processes read those shared materializations; they do not start local pollers. Endpoint registration remains separate
from capital authority. Authorized bootstrap drains a predecessor controller, publishes a fresh observation for the
exact source revision, and only then activates the execution controller. A failed initial sample leaves execution
inactive while the observation object's durable recovery continues to retry.

A capture invocation issues one journaled worker command. Its Restate invocation ID is claimed atomically in
`broker_observation_captures` before any broker HTTP request. The claim survives worker replacement, later captures and
source rotation, so a repeated or late invocation cannot repeat its capture. Publication and failure settle the claim
atomically with their existing database update. Replaying or interrupting an unfinished claim invalidates and fences
only the matching account, source revision and capture generation. A published lost result and a newer cut remain
usable, and interruption retains unknown HTTP quota debt. Trading mutations still invalidate the account-wide
projection. A reserved quota window schedules a
successor without sleeping inside the exclusive capture handler. Deployment activation waits for reserved quota
before capturing the fresh snapshot required to start execution. The same database transaction reserves the account quota before HTTP. Publication or failure replaces that reservation
with measured request debt in PostgreSQL, so losing the Restate result cannot repeat HTTP or discard outstanding quota.
The database generation continues to fence publication after mutations and rotation.

When the existing pending-cut query selects a recent same-revision observation, its
`bayn.broker.observation.fence` span includes three fixed boolean attributes under
`bayn.broker.observation.pending`: `newer_mutation`, `newer_broker_event`, and
`newer_notification`. They describe fences matched by that selected row in the pending query's
database snapshot, not a unique root cause or the earlier admission query's snapshot. More than
one fence may match. The trace does not prove that subsequent cache materialization succeeded,
and an empty pending result remains unexplained by these attributes. No identifiers, payloads,
additional queries, changed admission predicates, or altered error/retry behavior are introduced.

The observation owner's child runtimes share the worker's configured logger and tracer. The capture operation inherits
the native Restate attempt's trace, allowing scheduling, capture and publication delays to be inspected together. The
`bayn.broker.observation.poll` span contains capture and publication spans; capture carries its span and log context
across the broker runtime boundary. Existing publication logs are JSON with source revision, snapshot hash, original
observation time, next HTTP-budget deadline and trace/span IDs. The child runtimes create no additional exporter.

The execution controller and broker observation owner preload their small durable state with each invocation.
State reads therefore avoid lazy-fetch round trips before execution or capture. State mutations, capture claims,
quota reservations and replay protection retain their existing durable semantics.

Each capture brackets account and position reads with matching complete order, fill and fee histories. Consecutive
successful tickets with an unchanged latest fill can reuse the prior full after-history as the next before-history.
The after-history is always read in full, including old fill and fee corrections. A new fill, generation gap,
backward clock, failure or interruption discards that reuse. History endpoints run concurrently within each scan;
pagination, exact fill coverage, original timestamps and hashes remain required.
See [capture ownership](src/broker/alpaca/snapshot-cache.ts) and [history verification](src/simulation-reconciliation/broker-history.ts).
Reconciliation reads one complete cut. Routine account, position and health reads use the same
projection. Each continuous health pass reads and validates one complete projected cut for all six broker components,
rather than fetching and decoding the full history six times. The next pass revalidates a new read; no successful or
failed cut is memoized across passes. Unprojected broker health retains its independent endpoint probes. Final submission reads account, positions and orders from one payload and performs zero broker GETs.
Individual order recovery, filtered historical queries, asset metadata and calendar requests retain direct read access.
There is no refresh-on-miss path for normal submission.

Order history uses descending submission timestamps with an exclusive `until` cursor. A full page retains only
the complete newer timestamp groups and rereads its entire oldest group on the next page, including any siblings
hidden beyond the provider's page boundary. Original timestamp precision and response evidence remain intact.
A full page containing only one timestamp fails closed because timestamp pagination cannot establish its completeness.
The original capture deadline bounds pagination; duplicate, ordering, cursor and history-stability checks remain
mandatory. Boundary overlap can add requests, and full-history cost grows with the account's retained history.

Stable snapshots collect all currently available fee pages without an activity-creation `until` filter. Alpaca can
exclude an already reported settlement from that filter while its cash effect is visible. The bracketing histories
must still agree, and the capture deadline, duplicate detection, response hashes and fee date validation remain enforced.

Opening cash and fee baselines read the first retained account snapshot in broker source order. Their queries bind
the event's account and `ACCOUNT` kind explicitly so the existing ordered account-event index can find that snapshot
without scanning historical payloads. Events without a retained snapshot cannot define the baseline.
Observed cash-fee preparation uses that same indexed baseline reader before adding the retained fill and fee cash
deltas. Its regression checks the executed PostgreSQL plans against a populated account history, including foreign
accounts and account events without retained snapshots; this does not change fee bounds or ledger posting order.

Reconciliation first recovers previously committed fee plans under the writer fence before
accounting new fills, then ingests the broker cut, retains its cash precision and prepares new fee plans together.
If recovery or fill accounting was required, ingestion cannot prove it performed no posting, or preparation creates
pending settlement, accrual, activity or correction work, preparation commits independently before the second
transaction posts and verifies it. Posted fee plans also require their exact acknowledgement before this work is
complete. If no posting is required, verification and reconciliation share the preparation commit. Verification
runs behind an owned savepoint: failures during verification, including query errors, defects and interruption,
roll back its writes, commit the prepared broker facts, then surface the original failure. Cancellation after
verification has completed still allows masked commit cleanup to finish and propagates interruption. A failed
savepoint rollback or commit remains an error and cannot claim that preparation was retained. The operation rejects
an ambient transaction that would erase these boundaries.
Fee preparation rechecks the exact account, amount, time and precision binding without rewriting it. Failed
preparation rolls back the new cut and its precision together; previously committed plans remain recoverable.
Replay cannot change the retained precision or account binding, duplicate inventory debits or bypass writer fencing.

Close preparation waits for exact accounting and resolved broker evidence before constructing a liquidation plan,
including after a fallback obtains a newer cut. Missing settlement evidence keeps the existing position recoverable
with `CLOSE_RECONCILIATION_PENDING`; it does not bind an empty close plan, terminalize the cycle, clear restrictions
or authorize an order. The next exact cut can resume the same bounded close path.

Verified Dorvud broker notifications enter the account-keyed `BaynBrokerObservations/notify` handler through
Restate Kafka ingress. Bayn verifies the exact signed payload against its loaded broker account and credentials in
a journaled step, then retains its stable identity, original receipt time and database arrival time before
acknowledgement. These compact receipts permanently deduplicate republication and fence projections or captures
that started before a new notification arrived, including while the exclusive capture handler is running.
The private owner coalesces pending notifications into one canonical capture. The first notification in a pending wave
invalidates the older projection before waiting for quota. Raw websocket events never supply ledger fills or
trading authority; the existing complete, bracketed account/history capture remains authoritative. A published
canonical cut sends the controller a compact snapshot hash and original observation time.

`BAYN_BROKER_CACHE_MAX_AGE_MS` defaults to 60,000 milliseconds and accepts 1,000–60,000. Capture is bounded by the
smaller of the operation timeout and half the maximum age. A named financial completeness timer starts the next
refresh that far before the original observation expires, because quiet order streams do not prove that cash,
fees or historical corrections stayed unchanged. Notifications can preempt that timer; no ordinary polling cadence
or polling endpoint remains. Freshness starts at the earlier of capture start and the oldest original observation.
Expired, premature, corrupt, foreign-account, failed or wrong-revision snapshots fail closed. Restate's source,
epoch and sequence plus the database generation fence duplicate, obsolete and late captures. A failed capture or
publication invalidated by a mutation retries after one second, subject to the persisted HTTP quota deadline.
Quota waits release the owner and retain one durable successor. Restart and source handover preserve that debt;
neither transport deduplication nor a connected websocket replaces canonical financial idempotency or freshness.

Jev validates cached account, position, order and reconciliation timestamps against the sixty-second broker
observation ceiling, independently of its ten-second quote limit. A configured shorter cache lifetime still applies
at the projection read, and final risk authorization retains its existing freshness checks.
Maximum-hold, profit-target and protective exits use the same broker ceiling. An expired or future broker observation still
rejects the exit; accepting a cached position does not extend an executable quote's deadline.

### Streaming execution owner

`BaynExecutionController` is the sole account-keyed financial owner. Market changes, canonical broker
publication, and completed inference wake that owner. A successful pass does not schedule another ordinary pass.
The removed `BAYN_CYCLE_POLL_INTERVAL_MS` setting cannot select a second discovery path.

The market worker sends an advisory `MarketChanged` hint immediately after updating its projection. Native arrival
persistence retains its existing size/time limits and runs independently. There is no market-readiness SQL outbox or
audit-flush barrier before the hint. A scoped publisher retains one immutable request until its private wake completes,
and conflates newer changes into one pending request. Each producer has its own UUID and increasing sequence;
unrelated workers' clocks never order or suppress one another's hints.

Startup and recovery emit a hint even when bootstrap fails. Successful bootstrap emits another hint without requiring
a subsequent market tick. A process that crashes before acknowledgement restarts with a new, truthful recovery hint;
it does not recreate a lost request's identity or claim that another worker received data at the original time.
The authenticated public `marketChanged` gateway awaits private `wake`. That short exclusive handler records the hint
and durably schedules any required financial tick; the gateway does not wait for that tick to run. While the account
is busy, source incorporation continues and newer hints coalesce locally. Each stable publisher can have one outstanding
private wake and one public waiter, including across HTTP timeouts. A parent process that crashes can leave its accepted
wake behind, so this is not a global bound across arbitrary process restarts. The public request uses the immutable
event identity with zero completion retention: live retries join one invocation, while an old deployment's completed
source-mismatch response cannot poison registration handover. The private wake retains its seven-day deduplication.

A hint cannot supply prices, make an unavailable source usable, or grant order authority. The owner selects and verifies
its current projection, preserving actual source and receipt evidence. A new worker replays bounded Kafka history rather
than starting quotes and trades at HEAD; [the projection contract](src/market-data/streaming/README.md) defines those bounds
and their limits. Replay does not recover a lost worker's original receipt time or guarantee recovery before an opportunity
expires. The owner retains the original close-plus-two-second eligibility timer while quotes arrive early.

An account pass admits a JEV batch, the exact source reference, original expiry and irreversible staged claims in one
transaction with `jev_inference_work`. That row retains the admitted financial work and its one-way dispatch claim.
The owner durably sends `BaynEntryInference.evaluate` and returns. The provider-only
service can run while the account processes broker updates, protection or close deadlines. It never advances a cycle,
binds a decision, reconciles an account or transmits an order. A one-way SQL dispatch claim prevents a replay or replacement
worker from repeating paid work whose provider outcome is uncertain. Unknown outcomes retain their original expiry and
existing expense classification; a retry cannot invent a fresh validity window.
While a committed entry batch awaits its result, ordinary market hints wait until the earliest original batch or admission
expiry. Broker observations and inference completion still wake the owner immediately. The expiry timer survives replay;
market bursts cannot run redundant financial passes or move that deadline forward.
After a closed-window pass with no pending domain deadline, ordinary data hints retain their producer frontier
without scheduling another financial pass. Canonical broker publications still recheck authority, reconciliation
and the calendar through the existing financial-completeness timer. Inference completion, source startup, readiness
and recovery hints remain immediate. Any subsequent non-closed pass clears this suppression; established entry,
protection, close and recovery deadlines retain their existing scheduling.
Expired admitted work, including earlier authority generations, settles under the existing independent account
inference-expense owner. Its SQL page scan and persisted retry backoff never run in the account's protection turn.

Completion returns a compact event to the same account owner, bound to its source revision and activation epoch.
The owner resumes the original retained observation and result rather than discovering another batch for the consumed
window. The resume reader reconstructs and verifies the complete admitted source once at the database boundary and returns
that typed graph to the owner, including its snapshot and content hash. Admission commits the already verified source
reference so a replacement worker can verify that same manifest
without treating replayed bytes as a new live capture. Before binding or transmitting, the existing financial path
rechecks the current account, reconciled positions and orders, authority generation, unknown mutations, current executable
quote, risk and original admission/inference/submission deadlines. Late or stale completion cannot authorize an order.

Only domain deadlines schedule a timer: source eligibility, original admission or inference expiry, position protection,
maximum hold, session close, broker consistency, quota, financial freshness and explicit recovery. An actual state-machine
transition can schedule one immediate continuation. Source and pending-inference discovery wait for events plus the original
expiry, without a recurring one-second scan. Held-position protection still evaluates at most five seconds apart and keeps
any earlier maximum-hold or execution-close deadline. These timers bound evaluation, not broker-flat time; unavailable
quotes, accounting discrepancies and unresolved mutations still fail closed.

Persisted absolute deadlines are never moved forward by completion projection, journal replay or source redelivery.
Successful event turns replace one completion-deadline timer, cancelling superseded invocations. Failed source catch-up
probes leave the established normal or recovery lineage intact.
The send boundary calculates a transport delay from the original deadline with a one-millisecond minimum. The retained
`nextDelayMs` receipt field is canonical and capped at one day; it does not create a periodic timer or replace a later
absolute deadline. Attempt receipt timestamps remain in the bounded durable advance and failure metadata. A committed
completion replays the exact saved winner; latency claims require representative measured runs of the new runtime.

Execution receipts bind the physical worker source revision, image repository and digest independently of the
capital-authorizing build. Compatible releases preserve the original generation and mandate. The prospective
registration binds the existing approved request and build lineage to its physical build. Financial capture verifies
that saved binding when the reporting worker is later upgraded, preserving late-fee evidence. An unknown or different
worker build cannot establish correctly completed controller work or supported reporting provenance. Current qualification
uses `bayn.qualification-runtime.v2` with `decisionTrigger: streaming`. Retained v1 registrations remain readable, while
old polling latency/replay studies cannot qualify this runtime; a new prospective registration and live evidence are required.

This hard migration changes handler and journal shapes. Roll out immutable `RestateDeployment` revisions so in-flight
invocations retain their pinned old deployment. Do not force-repin an old invocation onto this revision. The controller
plan identity rotates once into streaming; no runtime switch or compatibility polling implementation remains.
See [Restate service versioning](https://docs.restate.dev/services/versioning).

Alpaca's Trading/Paper API limit is [200 calls per minute per account](https://alpaca.markets/support/usage-limit-api-calls).
Market-data subscriptions have separate limits. The cache preserves response rate-limit headers. Request cost
depends on history size and whether a completed prior scan can be reused. The background client's transport counts
every actual attempt, including startup verification, pagination and transient retries. Each attempt charges at least 600 milliseconds to the next permissible capture, targeting
100 background calls per minute on average, or half a smaller reported account limit. The three independent history endpoints run concurrently; individual captures can burst. Response headers showing one-quarter or less of account quota
remaining, and HTTP 429 responses, defer further background reads until the later of reset and `Retry-After`; missing
or unusable reset evidence causes a conservative sixty-second wait.

The account's PostgreSQL observation row owns the next permissible capture time. The capture claim and its conservative
unknown-work deadline commit atomically before HTTP. At default timeouts that deadline is three minutes. Completed
captures atomically settle their claim and replace the reservation with measured HTTP debt, including rate-limit
reset evidence. Snapshot invalidation and quota ownership use separate generations, so a mutation racing capture
cannot strand the quota reservation or let an older capture shorten a newer reservation. A failed settlement leaves
the conservative database deadline in force. No process-local budget or Restate result is authority to bypass it.

Canonical captures issue one journaled worker command. A quota-blocked capture returns its database deadline and
schedules a successor without holding the exclusive owner. Deployment activation uses a durable timer to wait for
quota before obtaining its required fresh cut. On the first activation of the new revision, the exclusive owner copies
any old Restate quota deadline into PostgreSQL with `GREATEST`, then deletes the old key. There is no second runtime
quota owner or compatibility polling path.

The worker starts its bounded capture clock immediately before the durable claim. A claim that commits after its
start deadline is invalidated without HTTP, and its unused reservation is settled only by the matching database
owner. Clock regression fails closed. Lost, spent and replaced-worker claims cannot repeat HTTP. Failed acquisition
and uncertain exits close their lazy runtime before recording failure or sampling request debt. A verified session
can survive a retryable read failure, with the failed cut discarded and the next capture still quota-bound.
Defects and interruption preserve unknown-work debt. Execution
requests use their existing client and consume the remaining shared account quota; the background budget does not
impose a global limit on other account callers.

One serialized execution pass reads its unfinished cycle once and advances acquisition, activation and decision
binding from their durable receipts. It stops at unavailable evidence, a terminal transition or one broker mutation;
repeating an admission transition fails closed. Each transition checks the current clock, and restart begins with a
fresh durable cycle read. Already committed intents retain exact immutable intent/decision validation without
repeating their writer-fenced commit transaction. Missing intents still use that atomic transaction; a persisted
`PLANNED` row is rejected as incomplete atomic persistence. Mutable intent state is read again after reconciliation,
and close planning reuses only the closure read by its owning pass.
Terminal close checks and archive-backed residual planning use the pass-owned reconciliation read instead of replaying the same
broker history through accounting and PostgreSQL. Reuse still checks evidence age and current authority; the broker
observations must cover the close intent's settlement time. The pass discards that evidence after a broker mutation,
and the next command reconciles again. Invalid or older preflight evidence triggers an immediate refresh before
waiting for settlement. If archive pricing fails, reconciled-position liquidation samples the broker
again after that attempt so intervening fills affect the remaining quantity.

Untouched expired entry approvals can retire under restricted submission authority only in canonical intent order.
A bound sell's remaining position keeps the cycle active; clearing that obligation requires fresh, exact reconciliation
with exact accounting and no unknown orders or mutations. Cleanup cannot enable trading or clear a manual hold.
Close documents retain their existing residual-replanning and hard-deadline failure behavior.

A known pre-transmission rejection records a bounded `denialReason` on its `SUBMIT_DENIED` event. Expired risk or
submission windows, stale or consumed broker state, changed authority, and known sizing failures retain distinct
reasons without storing exception messages or request payloads. The reason is hashed with the event and committed
atomically with the terminal intent transition. Exact retries retain that first reason; conflicting retries fail.
Historical events without a reason remain unchanged and readable, and unrecognized failures remain explicitly
`UNCLASSIFIED_INVALID_REQUEST`. A local denial is not broker rejection evidence and cannot permit another submission.

The existing account writer fence, durable `SUBMIT_STARTED` intent reservation, single-use exact reconciliation
version and persisted grant checks remain submission authority. The final projection permits only that reserved
intent's own start event; other mutations or newer durable broker evidence invalidate it. Submit/cancel invalidate
before transmission and after completion, failure or interruption. Unknown or unresolved requests block submission;
settled observations remain available to native reconciliation and lookup-only recovery so an unknown outcome cannot
deadlock its own recovery. Observing an account never grants trading authority.
Submit and cancel check the writer fence in their durable reservation transaction; there is no separate empty
precheck transaction. Final submit authorization and mutation outcome persistence retain their existing transactional
fences.
A later poll must start after the existing one-second broker consistency window. Lookup-only recovery invalidates a
cut when it finds new durable order state. Restarting a worker does not create a second cache or bypass reservations.

This is bounded observation of the broker, not an atomic lock at Alpaca. An external change can become visible on
the next complete poll. The existing risk freshness limit still applies at final authorization. Polling owns no
accounting writes, order submissions, capital grants or strategy decisions; native reconciliation remains responsible
for interpreting and persisting broker history.

## Active strategy

Entry observations use the native Jev reader. New entries must meet the cycle's submission deadline. Management
of an already filled position remains valid after that deadline within the execution session, using liquidation quotes
and accounted position evidence. It retains the original first-fill holding deadline and forced-close window,
including continuous crypto cycles whose entry lease lasts one minute.

Bayn supplies pinned `jev-1.14.0` with a deterministic candlestick PNG, verified candidate bars, quotes and funded
proposal economics. Current [chart questions](src/jev/staged-chart-questions.ts) use a single Box stage:

1. **CHART:** three independent presence judgments and support, resistance and consolidation Boxes. Code maps regions
   to exact source candle IDs with the renderer's projection. Inverted or out-of-range Boxes fail validation;
   rounded zero-area regions cannot identify a structure. Presence at or below 0.30 rejects its dependent setup.
2. **Funding:** code constructs at most one support-recovery and one base-breakout proposal using verified source
   prices, quantities, costs, stops and targets. The [source-feasibility gate](../../docs/bayn/pre-chart-feasibility.md)
   can reject impossible sources before either paid call.
3. **JEV:** the final call judges the funded proposal's setup and stop with the existing 0.70/0.30 thresholds.
   Retained crypto contracts also require target-obstruction evidence.

Each symbol commits its CHART terminal and handoff before final inference. Fast symbols may proceed while other
charts run, but selection requires the complete batch. Claims prevent repeated paid calls after retries or lost
acknowledgements. Current v40 cost projection expects CHART and JEV; historical BASE_START claims, skips, question
bytes and financial hashes remain readable through their original codecs. The original ten-second deadline bounds
inference and persistence. Bayn computes execution quantities, risk and exit triggers; current candidate admission
uses [candidate-only queries](src/jev/observation-query.ts).

The [TypeSafe SDK response contract](https://docs.typesafe.ai/sdk/python/api/types/responses#typesafe_sdk.ChoiceAnswer)
describes approximately normalized probabilities. Bayn requires a normalized distribution to fit within 0.005 of
each reported probability, so the total allowance scales with the number of choices. These are Bayn validation bounds, not a
provider precision guarantee. Score answers must also fit the same distribution bounds and a 0.005 score allowance.
Choice maxima allow only relative machine-precision roundoff, such as `0.45999999999999996` versus `0.46`.
This numerical tie check is separate from the wider decimal-reporting allowance for probability totals and scores.
It preserves the provider's selected label and numbers; a genuinely nonmaximum label still fails response validation.
Bayn retains the reported values and hashes without normalization. Selection uses reported probabilities; larger
discrepancies, mismatched choices or inconsistent scores remain unusable evidence.

An entry batch with no requested candidates commits its verified plan and complete excluded result in one PostgreSQL
statement. Admission still reproduces the stored observation and checks the original clock and evidence deadline.
An insertion failure rolls back both records; concurrent retries reuse the immutable result. Older unfinished plans
retain their existing recovery path. This avoids a second finalization transaction on all-excluded observations
without changing which exclusions can support a no-entry decision.

An on-time, verified all-excluded batch reports `SNAPSHOT_UNAVAILABLE` for missing candidate evidence or
`SNAPSHOT_STALE` for stale candidate pricing, with the affected symbols in its readiness message. It does not report
an inference outage when no model request was made. The observation remains unusable: source exclusions do not become
verified non-signals. Expired batch evidence reports `INFERENCE_EXPIRED`; inconsistent batch evidence retains
`INFERENCE_UNAVAILABLE`. Requested-candidate evaluation and all trading, freshness, and accounting checks are unchanged.

Each model request commits its at-most-once claim before inference. Entry batches with exactly one requested candidate persist the receipt, resolution and complete batch result in one
transaction. Entry results retain every excluded candidate in plan order. Entry batches with multiple requested
candidates retain independent receipts and all-candidate finalization. Atomic receipt recording and recovery lock
the batch before the request. A completed batch is verified and reused without opening another transaction. A
failure, defect or interruption during atomic persistence rolls back the receipt, resolution and result together;
the pre-call claim remains pending and cannot trigger another inference. Every consumer still checks the original
evidence deadline after persistence. Synchronous commit and standby durability are unchanged.

The submission window follows the entitled equity market calendar. Bayn can evaluate after the first completed minute
and the two-second decision delay, at 08:01:02 New York time when the current IEX window opens at 08:00. Equity entries
use up to 30 minutes of actual completed history and evaluate the source-controlled candidates independently until
five minutes before the close. The retained protocol also defines 120-minute crypto context for historical evidence
and position recovery; the current discovery and submission guards do not permit new crypto entries. The sequential
chart and Jev pipeline derives source-anchored proposals and ranks funded eligible entries by their weakest required
judgment, then modeled loss and stable proposal identity. Entry spreads may not exceed five basis
points for equities or 25 basis points for crypto. The market profile is part of the strategy identity. It selects at most one long position, capped at 20% of account equity and reduced when
the actual weighted target would exceed order, symbol, exposure or remaining daily turnover limits. The daily counter
includes both buys and sells. Allocation reserves slippage and any current exposure's liquidation notional before
bounding the target; the target weight is applied once. Exposure-reducing closes retain their existing risk exception.
The order cap reserves its full price allowance before sizing because it checks executable notional. Symbol, gross
and net exposure caps retain their reference-price basis. Buy-limit rounding stays inside the reserved allowance.
The current sandbox policy has no daily gross-turnover cap. Its v5 contract records
`maxDailyTradedNotionalMicros: null`, not a larger numeric budget. The sandbox cumulative drawdown cap remains
$10,000 and its daily loss cap remains $5,000. All sizing, buying-power, loss, drawdown, cost, authority and
reconciliation checks remain in force. Live and unspecified environments retain the exact v4 policy with $200,000
turnover and $5,000 drawdown limits. Retained v4 sandbox mandates keep their original $200,000 or $1,000,000 turnover
limits until explicitly rebound through the existing reviewed activation flow. The paired research request binds
the new policy hash; historical requests and decisions remain immutable. Unknown hashes and sandbox hashes on live
fail closed. Removing the paper turnover cap grants no live capital authority or profitability qualification.
Durable account/session turnover is retained across policy and worker changes, and completed
decisions are not reopened. The image's policy-hash annotation verifies the available uncapped sandbox policy for its
build-account sentinel; the durable mandate remains the authority for the active account policy.
A fresh, exactly reconciled flat PAPER account checks daily loss, cumulative drawdown and any configured gross-turnover capacity
before candidate discovery or paid inference. Acquired entry cycles repeat the check before inference and after
pricing reconciliation. `ACCOUNT_PROTECTION` and `TURNOVER_BUDGET_EXHAUSTED` report a blocked entry with reproducible
[account-protection evidence](src/jev/account-protection.ts). Bound positions and unsettled orders keep their recovery
owner; reducing exits and read-only observations remain available. Final submission still enforces every risk limit.

The runtime writes [version-eight entry batches](src/jev/batch.ts). Valid candidate evidence reaches the sequential
chart and Jev pipeline
without a momentum admission gate. Source unavailability, quote freshness, spread and displayed-size checks can exclude
a candidate before inference. Model refusals, unsupported judgments and unfunded source-anchored proposals remain
explicit abstentions. Current execution requires the committed chart handoff, complete receipts and the selected
proposal's exact protection. Retired batch contracts cannot start current execution. Inference and persistence retain
the original ten-second evidence lifetime; execution pricing retains its separate quote-age and price ceiling.

Current equity entries use capital-weighted whole-share quantities at the verified ask and LIMIT/DAY orders.
A single displayed ask size does not cap an order; allocation, buying power, order, exposure and turnover limits
bound quantity. Partial fills and cancellations retain their native recovery and accounting paths. Retained crypto
evidence preserves its fractional precision, LIMIT/IOC terms and original fee assumptions.

After selecting a candidate, entry planning reapplies the same spread and positive displayed-size rules to its
refreshed execution quote. A quote that widened or lost either side's displayed liquidity leaves the entry waiting
for fresh evidence before an intent is built. The accepted model evidence remains immutable; quote freshness,
quantity caps and final submission deadlines still apply. This entry check never suppresses a position-reducing exit.

Before selecting a nonempty entry's execution quote, a pass cache cut without the protocol's ten-second quote
headroom is reconciled once. Bayn then checks the original observation times against the existing broker-risk age
limit, current authority and clock again. If the refreshed facts cannot cover that quote lifetime or the model batch
deadline expires, the unbound entry waits for fresh evidence. Changed authority or expired broker facts still require
reconciliation. The model evidence remains immutable, current reconciled facts supply risk inputs, and
final intent, writer-fence and submission-expiry checks still apply. Each event or explicit deadline enters the same
reconciliation preflight; it does not expire broker-valid facts during one serialized preparation. The pass rechecks authority on
every reuse and discards its cache before post-mutation continuation. Quote and broker freshness limits are unchanged;
the preparation ordering does not guarantee submission.

Position management binds original accounted entry fills, posted inventory debits, and fresh reconciliation.
Gross entry fills minus posted coin debits and accounted protective disposals must equal held quantity. A missing or unposted debit cannot authorize
management. Overdue positions are evaluated before archive or model work, including crypto positions from a prior
UTC date. Expired broker evidence waits for reconciliation before authorizing a close. A 15-minute holding limit
starts at the first actual fill. A verified adverse bid triggers the absolute strategy stop. A verified bid at the absolute strategy target triggers
the application profit exit when a broker group has not already disposed of inventory. Its initial close must
commit before that quote expires, measured from the quote event time. Native targets bind the proof and deadline;
no model response authorizes an exit.

PostgreSQL checks the initial exit deadline in a deferred constraint at transaction commitment, after evidence reads
and insertion. A late transaction rolls back. Production uses the database wall clock; replay uses its persisted
account clock. This is the server acceptance boundary, not a guarantee about when the commit acknowledgment arrives.
A committed close retains its original trigger through partial fills and recovery after the initial trigger deadline.

New equity entries use native LIMIT/DAY orders capped at the original inference ask, rounded up to the broker price
tick. Current numerical evidence reports effective values of 0 bps for `numericalState.entryEconomics.maximumEntryQuoteDriftBps`
and `maximumEntryLimitSlippageBps`. Retained v38 inputs still record the original 10 bps values and reconstruct their
unchanged request and batch hashes. Both versions enforce the same zero entry allowances and broker tick rounding.
Shared protocol fields remain 10 bps because liquidation and proposal stop economics still consume them. Fees,
funding, exit prices and thresholds retain their existing contracts. Retained v38/v39 inputs and the original
[allowance cutover](../../docs/bayn/effective-entry-allowance-cutover.md) remain historical evidence; current activation
uses the [Jev 1.14 procedure](../../docs/bayn/jev114-box-cutover.md).

Quote-backed instrument-quantized closes use LIMIT/DAY equity or LIMIT/IOC crypto orders with an allowance bounded
by the existing risk policy, currently ten basis points from the verified bid. Close prices round toward the quote
to stay within that allowance. The durable
decision retains the original quote, phase-specific allowance, exact limit notional, and risk evidence; historical decisions without
an allowance retain their original exact quote limit. Quote freshness and submission deadlines still apply.
Bayn starts flattening five minutes before the close and
requires a flat account at the closing bell. Entries stop when flattening starts, and close orders remain eligible
until the actual close, including early-close sessions. The five-minute exit budget is an operational policy;
unfilled exits or unresolved reconciliation remain incomplete and visible.

During that close window, missing or over-late archive evidence, a retryable archive outage, or an archive read
timeout triggers a fresh broker reconciliation and the existing reconciled-position LIMIT/DAY close path. The close binds the exact
reconciled holdings and cannot exceed their remaining quantity. The archive read receives at most half the smaller
of the remaining execution-pass budget and remaining close window. It additionally reserves twice the already
elapsed preparatory work for a fresh reconciliation and close planning; a slow initial reconciliation therefore
leaves less time for archive reads. The overall pass and close deadlines still apply.
Malformed archive identities, hashes, ordering and lineage still fail. Unknown mutations, unresolved orders,
inexact reconciliation, stale broker state and expired close authority still prevent submission. This exit policy
preserves the reviewed close authority; current equity entries retain their evidence and LIMIT/DAY requirements.

Before that session-close window, an unavailable archive does not trigger a redundant reconciliation for a fallback
that cannot yet be used. Eligibility is sampled after the archive attempt, so work that crosses into the window may
use the fallback immediately; the close deadline is checked again after fresh reconciliation. Other before-window
waits retain the explicit close-eligibility deadline and react to market or broker events. Failed close attempts retain the original data reason in logs.
A verified snapshot whose executable quote is stale records `CLOSE_QUOTE_PENDING` and requests a one-second durable
continuation bounded by the session deadline. Source/bootstrap failures and archive timeouts
retain explicit recovery backoff. Only one serialized controller pass runs at a time; a continuation rechecks all broker,
authority, quantity, and quote-freshness gates. This reduces avoidable idle time but cannot guarantee a fill or a
maximum-hold exit when fresh executable evidence is unavailable.

Entry observations evaluate candidate availability independently. The active Jev protocol binds
`bayn.candidate-evidence.market-quotes.v2`. An equity candidate needs a quote no older than 10 seconds, a real trade
at or after the context start and available by observation, and at least one real finalized minute bar with a matching
observed-price feature. The latest completed minute must be present; older missing minutes remain explicit gaps.
The quote may precede the completed bar boundary. Neither a post-range trade nor a trade within the quote-age limit
is required. Jev receives the trade's actual age as context, not as an executable price. Quote and trade ingestion
delays still obey the feed bound. Missing current input or a stale quote excludes that candidate. Real historical backfills are usable after their
actual arrival and never supply a current executable quote.
Live Jev entry queries contain candidates only and do not require SPY or another benchmark. Independent momentum
research uses its own query with the actual reference series. Source identity, canonical ordering, watermarks,
finality, and premature data still fail the whole observation. Raw candidate rows, exclusions, and all observed matching
feature receipts remain in the hashed snapshot, including features for rejected candidates.

Missing historical minutes are reported with their timestamps and do not impose another warmup. A missing latest
completed minute or matching observed feature still blocks that symbol. The IEX feed can omit a minute when its
trades do not qualify for a bar; see Alpaca's [minute-bar rules](https://alpaca.markets/learn/stock-minute-bars). Bayn
never creates substitute bars. Return horizons without their actual reference bar and incomplete volume comparisons
remain unknown. Independent momentum research compares the earliest actual minute present in both candidate and
benchmark histories.
The active runtime accepts only the current observed-history contracts; retired snapshots are not converted.

Native Jev targets retain every candidate result and exclusion with the exact full-batch evidence. Source exclusions
alone cannot authorize a no-entry decision. A version-two or version-three entry batch with every candidate excluded by
a verified spread or displayed-size rule can. Execution pricing requires fresh quotes for positive targets and
reconciled holdings.
Historical momentum targets remain readable for audit.

Entry observations commit at most once per completed signal window within a cycle. Later events and restarts
consult the retained observation before another batch; interrupted or failed observations cannot repeat inference
on the same window. Entry recovers pending batches before full signal history and preserves every source gate.
Position management instead reads fresh liquidation quotes on each protection pass. Stop, profit-target and
holding-deadline evaluation need no model, feature history, inference batch or completed-window admission.

A newly committed terminal Jev cycle makes one best-effort attempt to seal its own expired pending batches, across
that cycle's recorded authority generations. This runs after the authoritative cycle mutation and uses the existing
configured operation timeout and cancellation-aware deadline clock. It never calls the model, waits for an original
deadline, revives a decision, or scans historical terminal cycles. Unattempted and abandoned outcomes retain the
original evidence semantics. A missing, unexpired, foreign-cycle or failed cleanup remains explicitly logged as
incomplete; typed failures, defects and cleanup timeout do not replace the committed terminal receipt. External
interruption still cancels and joins cleanup without undoing the terminal state. This is evidence closure, not a
durable retry queue or a guarantee against process death after the terminal commit.

Quotes, trades and the latest completed bar retain their declared feed-delay and freshness bounds. Older real
finalized bars can arrive through recovery before observation; their actual ingestion and receipt times remain
bound in the snapshot. Required benchmark and execution evidence must arrive within the existing deadlines.
Premature feed evidence, non-final bars, future arrivals and malformed inputs remain errors. Historical replay
uses the same observed-history policy and retains every rejected observation.

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
Requested candidates start concurrently across the complete source-verified batch, within its ten-second
validity window; a slow, failed, or missing result still makes the batch unusable for an entry.
If mandatory observation persistence consumes the original validity window before an unrecorded batch can start,
admission returns typed expiry and observation evaluation waits with `INFERENCE_EXPIRED`. It creates no plan,
request claim, model call or decision. The retained observation still consumes its signal window, and protection
checks remain first on every management pass. The admission span and JSON warning retain the batch and cycle IDs,
original observation and expiry times, checked time and elapsed admission lag. Clock regression, corrupted evidence
and persistence failures remain errors; recorded batches still recover against their original deadline.
Lost acknowledgements and process restarts replay committed evidence without repeating inference. Late responses
remain available for accounting but cannot change an abandoned resolution or a finalized batch.

Completed batch rereads load all requested candidates' claims, receipts and resolutions together, then retrieve
matching observations in one grouped query. Each distinct observation crosses the database boundary once and its
canonical content hash is verified once per read, with exact cycle, generation, snapshot, symbol and time membership
checked for every request. A batch with resolved candidate evidence uses three queries including its plan/result
read, independent of candidate count. Single-candidate evidence reads use the same verifier. Missing or corrupt
evidence and claims for sealed unattempted candidates still fail verification; validation is not cached across reads.

Current chart question preparation retains at most 64 successful canonical request bodies. Its key hashes the
complete chart, protocol, funding, question policy and selected stage, including actual source prices and image bytes.
Identical evidence reuses deterministic funding geometry while every caller receives a newly decoded request.
Changed quotes, fees, capital, source content or stage require preparation again. Provider responses, dispatch claims,
durable evidence membership, current authority and the original ten-second inference deadline remain independently
verified; a prepared request cannot authorize an order.

The cycle store retains at most one fully validated decision's canonical wire JSON, up to eight MiB, after binding
or a cold durable read. Every reread still queries PostgreSQL and requires full JSONB equality with that retained
body. A match returns fresh completion and generation evidence without returning or decoding the full document body;
changed documents return the complete body and take complete validation. Returned documents are detached, and
completion, supersession, current authority, pricing and expiry checks remain fresh. A retained decoding result does
not prove that its binding committed and cannot create a missing database row. The `bayn.cycle.decision-read` stage
records retained wire bytes, match and body row counts, and elapsed read time without recording document contents.

Native decision binding and position management use these contracts. Deployment and full lifecycle acceptance
remain separate requirements. Historical inference evidence, an API response, or a batch result grants no execution
or capital authority. Economic qualification uses the [current registered evidence policy](../../docs/bayn/jev-migration-validation.md#economic-acceptance).
The frozen v2 contract remains available for historical verification.

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
attempt then completes without inventing a fill. Once terminal, while the entry cutoff remains open, the standing
mandate may acquire a successor; [rearm eligibility](src/cycle/runner/calendar-decisions.ts) adds no extra minute
of cooldown. The successor waits for an unconsumed protocol signal window before another observation or paid call.
Zero-fill attempts do not exhaust a session-wide quota. Each new attempt requires fresh signals and pricing, exact flat reconciliation, no
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
accounting and flatness checks. An untouched same-plan cycle is preserved through this rollover, including fee-driven
cash discrepancies, incomplete reconciliation passes and execution-pass failures. Migration 0088 aligns the persisted
rearm predicate with this preservation; it does not repair historical records or clear authority by itself.
A bound pending or active cycle keeps its existing generation while recovery manages
the position; it cannot attempt authority rollover until the cycle is terminal.
An automatic failure before a research generation records any decision or intent can also settle that unused
generation when its plan has no pending or active cycle. Recovery still requires fresh exact reconciliation and the
existing OBSERVE successor and grant checks; operator restrictions remain held.
The existing activation path then verifies the grant before publishing the next execution driver. This transition
does not require a worker restart. An untouched, unbound cycle retains its plan until the session's entry cutoff,
including restrictions after market open. Its snapshot, decision and intent history must remain empty. Partially
bound cycles retain settlement handling. Migration 0071 repairs an already authority-blocked, untouched cycle only
before its cutoff, under the writer fence, with clear matching authority, exact reconciliation, flat positions and
no unresolved mutations or open orders. Manual restrictions and financial history remain protected.

When authority rollover has already terminalized an unused pre-submission cycle with a provenance restriction,
discovery may acquire a new immutable attempt under the recovered execution authority. It must find no snapshot or
decision evidence and reconstruct the original draft exactly from the currently approved strategy, account, mandate,
broker calendar and execution policy. The previous terminal record is retained. The existing rearm delay, submission
cutoff and fresh decision/risk gates still apply; other restrictions and changed contracts do not use this path.

Mutation preparation uses its verified durable decision and session binding plus fresh broker reconciliation. It does
not reread the market calendar after the decision is bound, so an unrelated calendar outage cannot prevent accepted
order recovery or the scheduled close. New decision construction still reads and verifies the broker calendar.
Cycle runners require an explicit decision-evidence verifier before durable binding. The verifier checks canonical
market-data references and owns any legitimate empty evidence; omitting it cannot bypass verification.
Each new entry risk decision retains its pricing quote event time and the snapshot's maximum quote age. Approval
expires at that event-time deadline or an earlier broker, intent, or session deadline. The final submit transaction
rechecks the persisted expiry after writer/grant locks and broker reads, so retries or worker restarts cannot extend
it. An expired entry follows the existing durable no-send path. Close-only recovery keeps its separate close lease.

Broker-session startup verifies account identity and permissions, account configuration, positions, orders, fills,
and order lookup access. It does not require the calendar endpoint, so an outage cannot prevent a replacement worker
from starting recovery of a bound decision.
Capital activation uses the current exact reconciliation for flatness, rather than the session's startup position
and order counts. A failed activation remains a typed initialization failure; the native controller reacquires its
scoped runtime on a subsequent durable tick instead of publishing a permanently passive OBSERVE driver.
Migration 0086 permits recovery of an OBSERVE successor restricted by an incomplete reconciliation after earlier
research trading has settled. It requires matching sandbox research ancestry, a fresh exact flat account cut after
the restriction, terminal intents, no bound active cycle, and no unresolved mutations or open orders. Both the
application selector and PostgreSQL authority trigger enforce the same settlement predicate. Operator holds remain
restricted and historical trading records are retained.

Broker reconciliation recaptures changing history or lagging fill activities at most twice, 500 milliseconds apart,
before persisting a snapshot. A broker terminal fill may precede local acknowledged-intent recovery; recorded terminal
outcomes and aggregate fills still must agree. Equity marks from separate account and position observations remain
visible as valuation differences, while cash, inventory, cost basis, fees, and ledger reconciliation remain exact.
Flat accounts require exact equity agreement. Matching receipt timestamps do not make separate broker responses atomic.

## Runtime architecture

Live decision construction runs in a single-use Node worker thread so synchronous validation and canonical hashing
cannot block broker-cache replies or controller timers. OBSERVE and PAPER share one construction permit per process.
The caller owns worker termination on success, failure, deadline or interruption; queued work cannot start until the
previous thread has terminated. The worker uses the same constructors and hashes, and the controller owns the returned
frozen document. Broker mutations and authority checks remain in the controller. Native replay provides the same
constructor in its virtual-clock runtime, preserving its sealed executable and deterministic timing.

Replacement execution workers start their read-only Kafka projection before exposing the Restate endpoint.
Their `/startup-ready` probe latches only after the initial history rebuild; the activation hook requires both
current replicas ready. Shared native activation preflight also waits for current history before reading the
predecessor and authority. Failure leaves the predecessor untouched. After startup, source invalidation still
blocks new entries while broker observation and liquidation remain available.

Each new native controller pass retains `jevObservationReferences` in its existing pass result and PostgreSQL
`last_pass` projection. The sorted, deduplicated hashes come only from successful Jev observation persistence or
successful batch-store results, including recovered batches. The journaled advance result binds these references
into its version-two execution receipt. Each hash resolves the exact persisted observation, whose manifest identifies its
snapshot and whose existing batch plans identify candidate requests and terminal receipts. Store access does not
prove that an observation was selected, submitted, traded, or profitable.

The `complete` flag describes only this pass's reference collection, not complete controller knowledge or capture
coverage. Ordinary passes create entry observations; pending entry-batch recovery has no fixed count.
The collection retains at most sixteen unique hashes (about one KiB of hash data). A legitimate recovery touching
more becomes explicitly incomplete rather than changing trading behavior. A failed store operation, unavailable
store instrumentation, or invalid reference also marks the collection incomplete. Waiting and expected failure
results keep references already collected; an aborted action without a returned result has no reference claim.
An empty complete collection means no Jev observation references were returned by these instrumented operations.
It does not rule out reuse of a previously bound decision or access to other evidence.

Legacy journal and projection results keep the field absent, with unknown reference coverage and byte-identical
version-one receipt hashes. Replays retain only their original references and do not rerun evaluation or fabricate
a fresh capture. This linkage does not prove full-session capture completeness or repair missing historical links.

- `BaynExecutionController` is the only scheduler. Restate serializes handlers by canonical account-binding hash,
  persists timers and retries, and resumes after worker replacement.
- The execution worker runs one bounded `advanceExecutionOnce` pass per tick. Restate is not treated as broker
  exactly-once delivery; durable intents and deterministic IDs remain the external-side-effect boundary.
- Execution acquires a scoped driver directly. Production and replay share one serialized generation-rebinding
  path: when authority changes, the next pass prepares its replacement before advancing. Failed or interrupted
  preparation retains the clients and retries preparation without running the stale driver. Production preparation
  is bounded by the existing initialization budget. Market projection prewarming and controller-status projection
  remain independent of trading acquisition, and public health derives from durable observations.
- Execution inherits the native Restate attempt's trace across lazy acquisition and recovering Effect runtimes.
  Controller scheduling, internal stages, PostgreSQL and broker spans can be inspected together in Tempo and joined
  to structured logs. Propagation reads existing context without adding durable commands or I/O.
- PostgreSQL is the authoritative cycle, grant, intent, mutation, reconciliation, and controller-status ledger.
- Generation settlement indexes the immutable decision document's authority-generation binding. Its existence probe
  stays correlated with the current generation, so PostgreSQL cannot hash and decode unrelated historical evidence.
  Migration 104 adds the expression index; the recovery predicates, row locks and authority checks remain unchanged.
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
  Its custom socket factory retains the SQL adapter's `TCP_NODELAY` setting for ordinary and cancellation connections.
  The aggregate execution deadline remains unchanged, and an uncertain mutation still requires durable lookup and reconciliation.
- Connection acquisition and transaction startup are cancellable, including when both pool connections are occupied
  or a BEGIN/fence-query acknowledgment is lost. Interrupted startup still rolls back before releasing its connection
  and writer permit. Commit and rollback retain their cleanup semantics. TigerBeetle requests have their own operation deadline;
  cancellation invalidates the transport and the next request creates its replacement without replaying a mutation.
- The pinned Effect 4 PostgreSQL adapter owns connections through its native protocol pool. Interrupted reservations
  return their pool slots. The integration regression cancels two queued writers and verifies that every pool slot
  remains usable; proving only one subsequent query misses a one-slot leak.
  Pool maintenance and connection deadlines use the live clock, so replay time jumps do not drive transport timers.
- Authority transition timestamps retain PostgreSQL microsecond precision as UTC strings through SQL comparisons and
  writes. Converting the transition cut through JavaScript `Date` can place it before a fresh reconciliation within the
  same millisecond and leave recovery restricted. Public authority observations keep their canonical millisecond format.
- The `effect@4.1.4` package patch exposes its SQL transaction semaphore. The writer fence supplies that semaphore
  with its reserved transaction connection, so nested SQL savepoints serialize while connection acquisition and
  transaction startup remain cancellable. The regression rolls back one nested transaction and preserves its sibling's writes.
- Bayn enables SQL span propagation. The pinned PostgreSQL adapter records `postgresql.pid` from the backend startup
  packet on statement and writer-control spans. Transaction startup and finalization stay under their owning
  `sql.transaction` span, including empty and failed transactions. Streams that acquire another connection report
  that connection's PID. Correlate the PID, database pod and exact span interval with PostgreSQL logs and wait samples;
  process IDs can be reused after a connection ends. This adds no SQL, network requests, polling or metric labels.
  Clients without SQL propagation leave shared caller spans unlabelled, and tracing-disabled calls keep their results.
  Slow and failed stage logs retain the PID when their own span carries it, including native writer controls, so
  PostgreSQL correlation survives an unavailable trace. Other span data is omitted and fast successful stages stay quiet.
- Stages record failures, interruption, and successful operations taking at least one second. The logs include stage,
  dependency where known, operation, elapsed time, and trace identity. Connection acquisition, transaction begin/commit/
  rollback, Alpaca reads, TigerBeetle requests, broker snapshot reads, and reconciliation persistence are distinguishable.
- Alpaca read-header spans retain request-local transport phase, attempt/start counts and the latest attempt's
  pre-dispatch and response-wait durations. Failed or interrupted reads log only those bounded fields and the authored
  operation. Pre-dispatch includes pool waiting and connection establishment; it cannot distinguish DNS, CONNECT or
  TLS. A dispatch start does not prove that the broker received the request. Mock clients without the interceptor
  report `unobserved`, not a fabricated phase. No request/response values, hostnames, credentials or account identifiers
  enter this diagnostic. Retry, total deadline, proxy ownership and all trading safeguards are unchanged.
- Jev HTTP spans capture only known rate-limit and retry response headers. Authorization, cookie, Set-Cookie and
  API-key header attributes stay absent. HTTP status and timing remain available. The inference client preserves caller-provided redaction.
- Rejected positions responses emit one bounded schema diagnostic on the existing read span and a warning. The
  `broker.decode_field` path uses only authored position fields and `[]` in place of array indices; issue, expected type
  and actual type use fixed categories. Payload values, arbitrary keys, schema messages and account identifiers are
  omitted. The response remains `INVALID_RESPONSE`; unsupported issue shapes report `unknown` rather than formatting
  the error. Successful reads, other endpoints, deadlines, retries, validation and freshness are unchanged.
- Operation-duration histograms use Effect's canonical boundary constructor, including the unbounded overflow bucket.
  Prometheus and OTLP retain the same finite buckets through 60 seconds and count longer operations in overflow.
  Effect 4.1.4 emits that overflow once as `+Inf`.
  Cross-service latency aggregation therefore combines matching buckets without changing alert thresholds or sample gates.
- Failed OTLP trace export attempts emit `Bayn OTLP trace export attempt failed` warnings to stderr. They contain the
  telemetry stage, service, source revision when configured, and HTTP status or transport reason. Collector bodies,
  headers, endpoints, and raw errors are omitted, and command JSON output stays on stdout. Successful exports remain
  quiet. These diagnostics run in the existing background
  exporter and preserve its retry and shutdown limits; they add no execution or closure calls. The pinned exporter can
  discard telemetry and disable exports for 60 seconds after failure, so retained structured pass profiles remain
  necessary when Tempo coverage is incomplete. A failed attempt alone does not establish permanent trace loss.
- A pass deadline records interruption request time and every active stage/dependency with elapsed time before joining
  cancellation. Nested deadlines share the pass's active-stage map; independent passes have separate maps. Its final warning separates
  `executionElapsedMs` from `cancellationElapsedMs`; `bayn.execution.timeout-recovery` and
  `bayn.execution.restriction-persistence` record their own completion durations. A timer that itself ran late remains
  visible in execution elapsed time. These measurements do not claim that an earlier uninstrumented stall had the same cause.
- A generation authority read gets at most one-sixth of the pass budget, capped at five seconds. Authority reads
  separately trace pool acquisition and query execution, and reuse the current transaction when one exists.
  Each uncached reconciliation broker read gets at most one-third of the reconciliation budget, or ten seconds with
  the current configuration. The aggregate pass budget still bounds reconciliation. Background broker polls use the
  adapter's request and retry deadlines, with the cache's freshness budget as their aggregate deadline. Startup preflight
  keeps its own request and retry deadlines. Every snapshot requires matching complete bracketing histories;
  eligible consecutive polls reuse the preceding full after-history as described under [broker polling](#broker-observation-owner).
- The dedicated Bayn PostgreSQL cluster logs statements exceeding one second and lock waits exceeding one second.
  `log_parameter_max_length=0` and `log_parameter_max_length_on_error=0` suppress parameter values. SQL statement text is
  still present in database logs. For a lock wait, correlate the PostgreSQL process ID, blocker ID, application name,
  and timestamp with Bayn's operation/trace interval; database process IDs are not trace IDs. A current read of
  `pg_stat_activity` with `pg_blocking_pids(pid)` distinguishes a lock from a running query. These diagnostic settings do
  not change replication, durability, volumes, or storage placement.
- The Bayn namespace log collector includes the CNPG postgres containers. Database pods do not inherit the
  application's part-of label, so discovery uses the namespace and explicit container names.
- TigerBeetle is the authoritative fee, cost-basis, cash, and realized-P&L ledger.
- Reconciliation reads accounting history once, derives each fill's expected transaction and ledger plan once, and
  reuses those plans for receipt and TigerBeetle verification. The separate completed-fill verifier is removed.
  Source economics, prior inventory including fee debits, transaction hashes, receipts, ledger records and balances
  must still agree. Recovery rebuilds previously committed fee and cash-settlement plans only when a posting is pending.
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
  Fees first observed or posted after the selected reconciliation retain their economic-date attribution and
  amounts, but leave the report `INSUFFICIENT_EVIDENCE` with `UNCLOSED_WINDOW`. A closed reconciliation cut cannot
  certify later fee evidence, including a delayed posting of an earlier observation.

- The public Bayn deployment serves read-only status and health. It does not schedule execution or hold mutation
  authority. Its Kubernetes readiness checks fresh PostgreSQL, ledger and cycle-projection reads. Broker reconciliation
  and the bound execution controller retain their own operational readiness in `/readyz` and `/v1/status`.
  The API requires `RESTATE_INGRESS_ORIGIN` to read the controller's sanitized shared `health` view before its SQL
  completion projection. This read remains available while an exclusive financial turn is running. Pending work
  retains its first accepted wake time across retries and coalesced notifications; an overdue obligation makes
  execution unavailable even when the last SQL completion was idle. A controller with no pending obligation can
  remain idle indefinitely. This operational view does not change financial completion receipts or business deadlines.
  It acquires no archive client and performs no ClickHouse probes. Without a direct market-data observation,
  `/v1/status` omits the `signal` dependency and reports `data.status: UNKNOWN`; archive connectivity cannot certify
  live Kafka availability. Trading retains the worker's direct Kafka checks and all entry and position-management gates.
- Broker egress is restricted to the configured Alpaca endpoint through the dedicated CONNECT proxy. Credentials and
  plaintext account identity must never appear in logs, metrics, traces, or status responses.

## Market data

Dorvud's optional technical-indicator stream is joined as immutable decision evidence when
`BAYN_KAFKA_TECHNICAL_FEATURES_TOPIC` is configured. See the
[streaming contract](src/market-data/streaming/README.md#technical-indicator-evidence) for timing, readiness,
source matching, replay and delivery requirements.

Alpaca WebSocket events enter the existing raw Kafka topics. Each execution worker owns a scoped Node worker thread
for its `@platformatic/kafka` projection and native arrival retention. The controller receives detached requested
cuts; readiness transfers no retained records. Shutdown joins journal finalizers, worker failure invalidates reads,
and interrupted snapshot requests cancel remote work.

Dorvud/Flink independently publishes rolling features to `torghut.market-features.v1`; ClickHouse retains the archive.
The equity [market profile](src/jev/markets.ts) defines the core universe and excludes SPY from entry candidates.
Current [Jev queries](src/jev/observation-query.ts) request candidates only. Independent momentum research adds and
verifies its own benchmark series. The public status service does not consume Kafka.

The projection yields to the Node event loop every 256 consumed records, including records discarded after an
assignment is revoked. Buffered history cannot monopolize the worker while broker I/O, deadlines, and scope
cancellation wait. Incorporation order and committed offsets retain the same rules.

The worker joins a completed feature window to its exact raw bar revisions, a fresh executable quote, and the
trade evidence required by the bound candidate policy.
Corrections invalidate an old feature until its replacement matches. Missing candidates produce explicit exclusions;
an all-excluded observation remains unavailable for entry. A benchmark is required only when the selected research
query requests it. Streaming failures never silently switch to the archive path. Reconciliation and the existing
close-window recovery remain available.

PostgreSQL commits the exact decision and pricing cuts with immutable source references before broker work proceeds.
Streaming evidence has a separate schema and carries no archive-watermark claim. Bayn owns no ClickHouse DDL or
backfill path. See [streaming operations and replay](src/market-data/streaming/README.md) for configuration,
recovery behavior, and evidence boundaries.

## Operations

### Runtime and historical-report configuration

The live service, execution controller and activation hook use Kafka/Jev market inputs. Their runtime configuration
does not require a pinned daily Signal snapshot or its evaluation dates. ClickHouse connection settings remain
required by the shared configuration for offline evidence reads; they cause no archive acquisition in public status.
This separation does not alter broker, authority, risk or provenance
configuration. The three live manifests omit all eight historical settings below; a running service container does
not supply a historical report context implicitly.

Native intraday forward-performance reports need only the account-bound runtime configuration. They reconstruct
their market evidence from each retained native snapshot, without an unrelated daily snapshot. Reports whose scope
includes legacy daily SIP requests also require all eight settings from the intended immutable daily publication:

| Setting                        | Historical input                 |
| ------------------------------ | -------------------------------- |
| `BAYN_SIGNAL_SNAPSHOT_ID`      | Immutable daily snapshot SHA-256 |
| `BAYN_SIGNAL_PUBLICATION_ASOF` | Publication date, `YYYY-MM-DD`   |
| `BAYN_SIGNAL_CALENDAR_VERSION` | Exact calendar identity          |
| `BAYN_SIGNAL_DATA_START`       | First data date                  |
| `BAYN_SIGNAL_DATA_END`         | Last data date                   |
| `BAYN_SIGNAL_LOOKBACK_START`   | Lookback start date              |
| `BAYN_SIGNAL_EVALUATION_START` | Evaluation start date            |
| `BAYN_SIGNAL_EVALUATION_END`   | Evaluation end date              |

The command requires `node dist/forward-performance-command.js --authority-generation <generation-hash>`.
Native mandates need none of these settings. Only complete absence is optional: partial or malformed historical settings,
including inconsistent evaluation bounds, still fail configuration before evidence reads. A legacy or mixed-history
scope without historical settings fails with an explicit error before any market query or ClickHouse acquisition;
it never omits legacy requests, selects a default snapshot, or implies zero trades or zero performance.
Historical SIP verification retains its explicit evaluation start; intraday archive evidence and immutable receipt
identities keep their existing contracts. Replay/backtest and historical acquisition tools retain their separate
`BAYN_BACKTEST_*` and `BAYN_HISTORY_*` settings.

The forward-performance command emits `bayn.forward-performance-report.v8`. Its hashed `scope` records the requested
`AUTHORITY_GENERATION` and `authorityGenerationHash`, including when no eligible financial cycle exists. Programmatic
account-history reports declare `ACCOUNT` scope. Requested scope does not supply missing financial source or strategy
bindings; those remain null until eligible evidence exists. Its `inferenceExpenses` section joins
all claimed requests, including no-trade cycles, to frozen quotes and verifies the complete account/session set in
TigerBeetle ledger 7002 before attributing estimates to the requested authority generation. Amounts retain USD_PICO
precision. Missing quotes, usage gaps and unverified acknowledgements remain explicit. The stored v4 trading receipt
is unchanged. With `--assessment <assessment-sha256>`, the report attaches a persisted system assessment for the same
account and authority generation. `operatingCostCoverage` is `COMPLETE` only when every candidate session in that
assessment is fully costed. `operatingCostScope` identifies its registration, source cut, and as-of time; it does not
extend that evidence to other windows. Without a matching assessment, coverage remains `INCOMPLETE`. Tariff estimates
cannot establish fully costed profitability. See the [system assessment command](src/system-assessment/README.md#private-reporting-command)
for prospective registration, source capture, and immutable assessment receipts.

### Private inference operating-cost report

The v4 trading receipt verifies trading transfers and broker fees. Its fields do not include operating expenses:
`otherChargedCostsMicros`, `netRealizedPnlAfterCostsMicros`, and `netRealizedReturn` remain null, with
`OPERATING_COST_EVIDENCE_GAP` and profitability `UNDETERMINED`. Independently known cost-coverage, missing-ledger and
unsettled-fee gaps remain explicit when starting capital is unavailable; unavailable financial totals remain null.
Verified gross trading P&L and fees remain visible when the required financial boundary exists. The v6 report's
attached `systemAssessment` supplies actual net economic profit, the policy-bound qualification basis, and
separate profitability and edge verdicts for its registered window. Current assessments use actual fully costed profit;
retained assessments keep their original conservative basis. It does not rewrite the v4 receipt.
Exact trading reconciliation does not prove inference, data, infrastructure, or research expenses are zero.
Complete implementation shortfall also remains unresolved without explicit cost evidence. Existing immutable
receipts keep their original bytes and hashes; this correction applies to newly computed reports.
Tariffs and expense packets are configured on the private command below. Their account/session scope is not
silently applied to a generation or window report.

Inference expenses are distinct from broker cash and execution fees. The read-only operator command reads claimed
Entry claims and their provider stages across all cycles for one account and exchange-session date, including blocked and no-trade cycles:

When a newly acquired request expires during durable claim persistence, the worker records a `NOT_DISPATCHED`
receipt before returning the deadline failure. This positive pre-HTTP evidence supplies zero tokens and zero cost
without a tariff or a TigerBeetle transfer. Missing receipts and dispatched requests without usage remain unknown;
historical gaps cannot be classified as free from the absence of a provider response.

```sh
bayn-inference-cost --session 2026-01-02 --rate-card /private/inference-rates.json
# An already exported, private evidence cut can be evaluated without network or credential access:
bayn-inference-cost --evidence /private/inference-evidence.json --rate-card /private/inference-rates.json
```

The database mode requires `BAYN_POSTGRES_URL`, `BAYN_ALPACA_ACCOUNT_ID`, and the normal PostgreSQL TLS settings.
It does not acquire a broker client, inference client, writer fence, or execution authority. The account and session
filter execute in a repeatable-read, read-only transaction. Reports retain the complete request and quote set without
truncating large sessions. Query, socket and connection deadlines remain enforced. Keep evidence, rate cards, and
report outputs private; they are not public status endpoints, source fixtures, or CI artifacts.
`node dist/inference-cost-command.js` is the corresponding compiled entry.

Forward-performance reports discover generation-scoped expense sessions with a direct generation predicate and
the request generation/cycle index. Account-wide discovery retains all generations and the complete-session limit.

Migration 190 closes expired v3 Jev batch plans from terminal cycles once, without restoring a retired inference
path. It verifies the original plan and request hashes and independently committed claims. Requests without claims
remain `UNATTEMPTED`; claimed requests without receipts receive an `ABANDONED` resolution. Original evidence stays
immutable, missing receipts do not become zero-cost evidence, and unexpected provider receipts abort the migration.

The native execution server also owns an independent inference-expense projection. It subscribes to committed
PostgreSQL notifications before draining retained work at startup and after every reconnect. Admissions, source changes,
terminal cycles and research receipts wake independent account and research projections; notification bursts coalesce
into one pending wake. Idle projections perform no work-discovery queries. Original batch expiries and persisted recovery
deadlines schedule known work without renewing its deadline. Each account pass reads at most four pages of 64 pending
terminal-cycle batches and settles those past their original request expiry
through the existing idempotent finalizer. This closes evidence after an admission expires or the process restarts;
it makes no provider calls and cannot bind a decision or authorize an order.
An account-bound cursor survives physical session recreation and wraps at the end of the sweep, so failed batches
remain retryable without starving later work. Process restart may reset this progress hint; committed results remain authoritative.

The same pass then reads at most 64 changed, billable sources for its bound account, freezes the original request/receipt/resolution hashes and tariff
in `inference_expense_quotes`, and posts deterministic transfers to TigerBeetle ledger **7002**. Current Jev-only
requests retain separate `CHART` and `JEV` stage quotes, including unsuccessful calls. Historical requests retain their original `BASE_START` quotes and skips,
with batches of at most 64 quotes per write. Their transfer identities include the
provider stage; retained single-provider Jev expenses keep their original identities. That ledger's unit is
**USD_PICO**: one USD is 1,000,000,000,000 units, so a single input token at the current Jev list price records 42,000
units without rounding each call. Session accounts debit estimated inference expense (code 510) and credit
estimate clearing (code 230). The trading ledger and broker cash balances retain their existing units and purpose.

Each account's expense pass has one nonblocking PostgreSQL advisory owner across execution-server replicas.
Research expense projection uses a separate owner and continues independently. Each pass owns one physical
PostgreSQL connection with the normal TLS and query, socket and connection deadlines. Its statements commit
normally before ledger I/O; closing the connection releases ownership on completion, failure or interruption,
including a lost lock-acquisition response. A replica that encounters a busy owner retains that known obligation and
retries until it can drain, including after an owner crashes; successful drains return to waiting for committed hints
or an original deadline. Failed work uses capped recovery backoff. Ownership
avoids duplicate scans and quote contention; frozen evidence and deterministic ledger IDs still enforce correctness.
During ledger I/O, a same-session keepalive runs at half the configured PostgreSQL statement/connect budget to
preserve ownership through the unchanged socket inactivity deadline. Separate LISTEN sessions use the same physical-session
keepalive, without holding a transaction or discovering work. A listener failure interrupts its drain and reconnects
before recovering retained work; a keepalive failure interrupts the affected session.

PostgreSQL delivers these hints at commit. If its notification queue fills, the notifying domain transaction fails
and rolls back. The caller must observe that failure and recover the same durable identity before retrying.
Listeners remain outside transactions while idle so they do not retain notification-queue history.

Migration 173 backfills pending work once from the retained request and quote metadata. Inserts of resolutions,
receipts, handoffs, claims, terminals, and skips enqueue the affected request in the same PostgreSQL transaction.
Discovery examines this queue instead of rescanning historical requests on every pass. Only the selected batch
loads the original request, handoff, receipt, resolution, and stage evidence for verification. Coverage counts distinct
provider stages so multiple retained quote versions cannot hide an unquoted stage.

Freezing quotes retires a queue item only when its current source is fully covered. Cleanup compares the observed
sequence revision, preserving a concurrent late receipt; deletion and re-enqueue cannot reuse a revision. A crash
between freezing and cleanup leaves recoverable work. Historical quotes, tariffs, verification timestamps, financial
transfers, and source evidence keep their original identities and bytes.

This projection starts with sessions on 2026-10-05 and the reviewed, frozen Jev 1.13.0 list-price assumption:
$0.042 per million input tokens and zero output charge, verified at `https://docs.typesafe.ai/models` on
2026-10-07 UTC. Decisions API charges use its standard input and cache tariffs, with free output, verified on
2026-10-25 against the [Decisions guide](https://developers.openai.com/api/docs/guides/decisions) and
[pricing table](https://developers.openai.com/api/docs/pricing). Cache reads and writes are subsets of total input;
the projection subtracts them before applying their separate tariffs. The rate card identifies where Bayn applies
these assumptions; it does not establish a provider invoice or guarantee future prices.

Current snapshots use `bayn.inference-cost-evidence.v2`, include the committed handoff, and report both stages in
`bayn.inference-cost-report.v3`. `requestCount` counts parent claims and `providerRequestCount` counts their stages.
Retained v1 financial evidence and quotes remain auditable through a read-only projection; they cannot enter the
current executable request codecs. Later reviewed tariffs apply to new quotes. Existing quotes cannot be repriced
or deleted. A lost TigerBeetle or PostgreSQL acknowledgement replays the same records and verifies all metadata.

A committed chart response can be priced when the dependent Jev call fails or its completion is lost. Missing Jev
usage remains unknown. A subsequent retained Jev receipt adds that stage's expense without charging the chart again.
A skipped Jev call is zero only when the handoff or original expiry receipt proves non-dispatch. Missing responses
never establish a free call. `verified_at` proves the frozen quote's expected ledger records, not invoice reconciliation.
Retained rejected or abandoned responses with valid usage remain included. Earlier sessions remain outside coverage.

The projection owns separate scoped PostgreSQL and TigerBeetle clients. Closing positions never waits for it.
Both execution replicas may safely recover the same pending quotes. To inspect a complete private session cut:

Expense reports drain requests and frozen quotes through one streamed PostgreSQL statement. Its original snapshot
also covers reads inside a READ COMMITTED execution writer transaction. Read-only reports and source captures finish
their enclosing transaction before reconstructing source evidence, verifying frozen prefixes, hashing the cut, or
reconciling the external ledger. Verification uses the captured rows and rejects malformed or incomplete evidence;
it never rereads a repaired request in place of its original cut. Writer-fenced evaluations retain their transaction
and roll back on verification failure. Pricing and coverage reuse decoded usage facts; a charge bound to an earlier
pending source prefix is validated against that prefix. The complete-session limits, SQL and socket guards, and
operation deadlines remain unchanged. The reader pins a native TigerBeetle timestamp and verifies every session
transfer and the history-enabled account balances at that cut. A subsequent quote read identifies legitimate charges committed
while the report runs; unknown transfers and mismatched balances still fail. Only the original captured quotes
contribute to the report subtotal. Trading and expense posting continue throughout the read.

Current staged financial evidence shares initial and selected chart preparation only within one synchronous request
decode. Reuse binds the complete canonical chart, protocol, funding and response material, including response bytes,
not merely claimed hashes. Every checkpoint, handoff, receipt, original clock and completion check remains in force.
Retained protocols keep their original readers. This reduces repeated source reconstruction without narrowing complete-session
coverage or treating booked trading results or estimated model costs as fully loaded profit.

The `--ledger-session` command emits `bayn.inference-expense-ledger-report.v3`. Its `coverage` includes the exact
`matchedQuoteHashes`, the current-source `knownEstimatedCostPicoUsd` subtotal, and provider stages on
`requestsWithCoverageIssues`. The underlying ledger reader retains its v2 contract and verified transfer totals;
the additional CLI fields remain metered diagnostics, with `invoiceReconciled: false`.
`sourceAsOf` identifies the PostgreSQL capture;
`ledgerTimestampMax`, `verifiedSessionTransferCount` and `exactLedgerPrefix` identify the verified native prefix. `transferCount` and
`knownEstimatedCostPicoUsd` describe the captured quote set. Forward reports retain both cut witnesses. These
timestamps belong to different systems and are never compared to infer ordering. Pending quotes remain explicitly
unverified, and verification does not establish invoice reconciliation. Stage counters use only captured quotes: a
validated priced quote resolves an earlier pending quote for the same stage, including proven zero-cost non-dispatch.
A stage with no priced quote remains a gap; later owner quotes cannot resolve a gap in an earlier capture.

```sh
node dist/inference-cost-command.js --ledger-session 2026-10-06
```

This mode needs the database/account settings above plus `BAYN_TIGERBEETLE_ADDRESSES` and the normal cluster ID
(default 2001). It reads the frozen tariff rather than accepting a replacement rate card. It verifies every original
request graph, the full scoped TigerBeetle account and transfer sets, and posted balances. `coverage` lists missing
quotes, pending verification and priced-usage gaps; `completeMeteredCoverage` requires all three to be zero.
The report gives the source cut and ledger observation times separately. Concurrent posting can fail reconciliation
and must be retried rather than accepted as a matching subset. Even complete metered coverage remains an estimate:
The private ledger command's `coverage.requestsWithCoverageIssues` identifies each missing quote, unverified ledger acknowledgement, unknown
usage or unpriced model with its request ID, purpose and immutable evidence hashes. It excludes account identity
and model payloads. An abandoned request without a receipt remains an unknown charge; absence of a response cannot
establish that the provider performed no billable work. The forward-performance summary retains aggregate counts.
`invoiceReconciled` is false. Prepaid credit refills, provider invoice allocation, data, infrastructure and research
expenses need their own evidence; this projection alone cannot populate complete economic profit or qualify a policy.

Rate cards use `bayn.inference-rate-card.v1` with a `rates` array. Each rate has `provider: "typesafe"`, an exact `model`,
`currency: "USD"`, a `source` description, canonical UTC `effectiveFrom` / exclusive `effectiveUntil` instants, and
`inputMicrosPerMillionTokens` / `outputMicrosPerMillionTokens` as unsigned decimal integer strings. Supply the tariff
applicable to the requested period; a list price is an estimate, not proof of a negotiated rate or an invoice. Model
intervals may not overlap. Missing model/date coverage is unpriced, not free. An explicit zero output rate is valid.

For non-200 Jev responses, the client reads at most 8 KiB within the original inference deadline and retains only
validated pinned-model and input/output usage fields for metering. The failed receipt's response hash binds that
exact metering projection, not the complete HTTP error body. A separate optional
`bayn.jev-provider-diagnostics.v1` projection retains a provider request ID (at most 128 ASCII identifier characters),
structured error code/type (at most 64 characters each), and a valid `Retry-After` delay up to 24 hours or HTTP date.
Client errors retain header identifiers and retry hints when reading the body fails or reaches its original deadline.
Error text, echoed prompts, credentials and arbitrary fields are excluded. These provider-supplied diagnostics
describe the response; they neither establish billable usage nor schedule a retry. Missing, malformed, oversized or interrupted usage remains
unknown; status failures never authorize a decision. Previously saved receipts and their missing usage remain unchanged.

The report verifies immutable request, receipt, rejected-response, and resolution hashes. A rejected or abandoned
decision can still carry billable usage. A claim without retained usage stays unknown: it does not prove either that
the provider received a request or that no charge occurred. Identical repeated evidence is deduplicated by request
identity; conflicting duplicates fail. Token counts are safe integers. Cost arithmetic retains pico-USD precision
and rounds the aggregate upward to micro-USD only once. These are metered estimates, not invoice-reconciled costs.

`bayn.inference-cost-report.v3` includes `requestTimings`, keyed by the same request/stage identity as the cost
lines. Each row retains the provider start time when recorded and the priced amount in pico-USD. A metered failure
can have a known expense and an unknown start time. Tariff selection may use the existing handoff or observation
reference when needed; that reference is never reported as an observed provider start time.

`knownEstimatedCostMicros` is the priced, recorded subtotal. `estimatedTotalCostMicros` is null whenever any claimed
request has unknown usage or any metered request is unpriced. `invoiceReconciled` remains false. The account binding,
session, as-of cut, evidence hashes, tariff hashes, and report hash make an exported report reproducible. This command
does not write to TigerBeetle or change the broker's cash balance. A strategy economic report may subtract the supported
operating-cost estimate from trading P&L while retaining its incomplete-coverage status; provider invoice reconciliation,
credits, taxes, shared subscriptions, data costs, and allocated infrastructure costs remain separate evidence requirements.

Supply `--expenses /private/expenses.json` to produce `bayn.inference-economic-report.v1`, containing the unchanged
metered `inference` report and a separate `economic` report. The packet has `evidence` conforming to
`OperatingCostEvidenceSchema` in `src/operating-costs.ts` and `artifacts: [{ sha256, path }]`. Artifact paths resolve
relative to the packet; each original file is rehashed before reporting. Keep invoices, receipts, account bindings,
reviewed allocations, and results outside the repository and public endpoints.

The normalized evidence binds the same account/session, its as-of cut, an optional reconciled trading P&L source,
and explicit coverage for `INFERENCE`, `DATA`, `INFRASTRUCTURE`, and `RESEARCH`. Every complete category, including
zero expenses, needs supporting source evidence. Consumption lines retain invoice/line identities, original file
hashes, service dates, credits, all account/session allocations and the unallocated remainder. Allocations and
credits must reconcile exactly. Identical imports are idempotent; conflicting identities, reused credit/payment
artifacts, unsupported coverage, and over-allocation fail. A credit note is assigned to one original invoice line;
split credit documents or partial invoice payments require an explicitly extended normalization contract.

Prepaid credit purchases belong to `prepaidFunding`, not session consumption. Invoice and payment-receipt evidence
describe one purchase, not two expenses. No remaining prepaid balance is inferred without an opening balance and
complete usage history. A provider payment receipt is not a bank reconciliation. An inference invoice allocation
replaces the tariff estimate for economic P&L; it is never added to the same estimated usage. The frozen qualification
cost comparison separately uses the greater of the applicable tariff or actual inference expense. Missing model
usage keeps that qualification amount unresolved even when a complete provider invoice is available.

The `economic` result uses `bayn.operating-cost-report.v2`. It reports actual fully costed profit in
`netEconomicPnlMicros` and conservative qualification profit in `qualificationPnlMicros`. The qualification figure
subtracts `qualificationPremiumMicros`, the excess of the greater invoice-or-tariff inference cost over the invoice
amount, from actual profit. This applies the conservative inference rule once. The qualification figure is null if
any operating-cost category, trading P&L, or required inference usage is unresolved. Zero-trade sessions still retain
their operating expenses. A positive actual profit can therefore have negative qualification profit.
These operating-cost report fields retain their existing conservative meaning. The current system assessment uses
actual fully costed profit for its qualification series and marked-risk path; the tariff premium remains a diagnostic.
Retained assessments continue to reproduce their original conservative deductions.

`netEconomicPnlMicros` and `totalOperatingCostMicros` remain null until all expense categories have complete evidence.
Partial reports show invoice and tariff subtotals separately and expose unknown/unpriced inference usage. Source
hashes prove file identity, not issuer authenticity, correct classification or coverage completeness: those remain
reviewed input assertions. This read-only import never mutates broker cash, TigerBeetle, an invoice provider or a bank.

### Operational diagnostics

Every native execution advance emits one correlated completion or failure record with its controller key, epoch,
sequence, source revision, wall elapsed time, outcome, receipt and next delay when available, and a per-pass
`stageTimings` profile. Each stage includes its dependency and operation, call count, inclusive elapsed time, maximum
call time, failures and interruptions. Nested stages overlap; their times must not be added to estimate wall time.
The profile uses the existing stage clocks and in-memory pass scope, without additional database or network work.
Execution-document construction uses the complete durable-document decoder's active-strategy check and returns its
validated document directly. Durable reads retain the same evidence, identity and risk validation.
Broker submission distinguishes `entry` and `close`, while its transport stage records `SUBMIT` or `CANCEL` through
the complete response and classification. SQL transaction acquisition, lease checks, begin, commit and rollback have
separate spans. SQL `server.address`, `server.port` and `db.namespace` identify the configured connection target,
including URI host, port, user and database overrides. See the
[critical-path investigation](../../docs/runbooks/bayn-cycle-operations.md#execution-critical-path).

Jev observation reconstruction failures retain a bounded `observationCheck` and, for broker snapshots, an
`observationField`. The top-level error identifies schema, source reconstruction, observation time, universe/feed/topic,
window, decision lag, session boundary, premature/stale portfolio evidence, feature definition or content identity.
The underlying cause remains attached, but arbitrary provider payloads and account data are not copied into the
top-level diagnostic message. Valid observation bytes, identity hashes, rejection predicates and freshness limits
are unchanged. These are failure explanations, not permission to bypass a failed check.

The last terminal cycle may include `entryAllocationReason`. `TURNOVER_BUDGET_EXHAUSTED` means a retained no-trade
decision had a positive signal, a flat portfolio, zero allocated capital, and earlier recorded account/session turnover
at least as large as its bound limit. `ZERO_ALLOCATION` makes no claim about which limit caused a zero allocation.
Missing historical facts remain unclassified. This explanation stays on the last cycle after a following session is
created; it does not rewrite the immutable target-plan reason or change any trading limit. Current turnover checks
admit the immediate sell-plus-buy adjustment, while strictly exposure-reducing closes retain their separate exception.
They do not promise a hard round-trip ceiling that reserves every future sale of newly acquired inventory.

Kafka supervision retains the first invalidation cause in each epoch. Rejoin, rebalance, reassignment and stalled
heartbeat signals have bounded reason codes; arbitrary transport error text is not included in failure telemetry.
Recovery logs connect the failed and rebuilt epochs and record time from the observed failure to a completed bootstrap.
Retries and the existing cooldown do not relax assignment revocation, source verification or required history barriers.
Transport recovery establishes an available projection, not fresh session data or a tradable signal.

The dedicated PostgreSQL cluster collects relation and WAL I/O timings using PostgreSQL 18's `pg_stat_io` and exports
bounded backend-wait and aggregate synchronous-standby measurements. Timing settings, metric availability, statistics
resets, and the distinction between active-query age and actual wait duration must be checked before attribution.
See the [cycle operations runbook](../../docs/runbooks/bayn-cycle-operations.md#database-latency-investigation).

### Delivery

Normal delivery uses the shared Kargo path:

1. merge reviewed source to `main`;
2. build the exact multi-architecture image and publish its immutable `kargo-sha-<source>` alias;
3. let the `bayn` Warehouse and automatic Stage copy that source into `kargo/bayn`, update all three runtime image
   bindings and the existing research build lineage, and push the generated GitOps commit; and
4. let Argo reconcile the execution worker, activation hook, and status service in their existing sync order.

Builds are scoped to Bayn inputs and finish when later commits arrive. There is no separate release workflow or
promotion-eligibility script. Kargo controls delivery; the native activation hook and runtime enforce the configured
account, strategy, capital grant, reconciliation, and order-risk contracts.

A release that retires executable decision or market-data contracts must follow its reviewed cutover procedure.
Verify that unfinished cycles remain recoverable by their owning release and that broker orders, positions and
ledger balances reconcile before the handoff. Retain terminal financial documents and their original hashes.
The current strategy transition is documented in the [Jev 1.14 cutover](../../docs/bayn/jev114-box-cutover.md).

Do not deploy directly or submit a broker order manually. A code-only release cannot change the sealed research request
or grant live capital authority. When the strategy identity changes, rotate and review the sealed PAPER research mandate
with the same broker identity and risk limits before promotion; Kargo then carries that request into the new build
lineage. Image publication alone does not authorize the revised strategy.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: current dependency and execution-readiness projection.
- `GET /status-readyz`: status-service readiness, requiring a fresh health pass and available PostgreSQL,
  TigerBeetle and cycle-projection reads. The status Deployment uses this probe so broker-confirmation waits and
  trading restrictions remain visible through `/v1/status`. Execution readiness and order admission are unchanged.
- `GET /v1/status`: bounded controller, strategy, authority, cycle, reconciliation, accounting, build, and blocker
  state.

The status process opens without a live broker HTTP preflight. Its health passes read the revision-bound canonical
broker projection each time, so an unavailable broker remains visible as degraded status and can recover without a
process restart. Execution workers retain their verified broker session and all existing order-admission checks.

Status [economics](src/cycle/observability.ts) labels cumulative accounting `ACCOUNT_HISTORY`, spanning authority
generations. `realizedCloseCount` counts SELL accounting transactions, including partial fills. Its execution-fee
subtotal includes recorded fill fees and posted broker fees; unposted charges and operating expenses remain outside it.
The retained `forwardPerformance` receipt identifies its own generation, source revision and measurement window,
independently of the current worker. When absent, it is null with `forwardPerformanceUnavailableReason=NO_PERSISTED_RECEIPT`.

The private execution worker also serves `GET /startup-ready` for its initial history-rebuild barrier; it is separate
from status-service health and current trading readiness.

When all snapshot candidates are excluded, structured `inputReadiness` retains the rejected observation's window,
required feature definition, candidate count and counts with matching features or a completed final-minute bar.
These bounded diagnostics retain their original observation time. They describe that failed source cut, not current
consumer health or upstream completeness. Free-form provider payloads, symbols and prices stay out of this field.

`executionSession` in `/v1/status` reports the current session's business readiness separately from process health and
startup ownership. `PREOPEN` and `WARMUP` require realized PAPER authority, clear kill state, exact reconciliation,
zero unresolved mutations, an account-bound broker and a matching active Restate controller with a durable pass.
They do not require a snapshot before the first full rolling window exists. `INPUT_UNAVAILABLE`,
`EVALUATION_UNAVAILABLE`, `DECISION_LAGGING`, `BLOCKED` and `RECOVERY_ONLY` are not ready. An ordinary no-trade result is
`ABSTAINING`; it is distinct from a blocked session. The authenticated shared
`BaynExecutionController/<account-key>/activateDeployment` handler verifies deployment ownership and handoff, warms
the private broker-observation owner, and waits for a fresh completed native pass and its successor after the
sequence observed at request entry. Reactivation wakes a deferred controller even on the same revision. Its immediate
probe is bound to the activation invocation and worker revision; retries retain that identity, and a new explicit
activation can retry an exhausted probe. Delayed deliveries remain subject to the existing exclusive sequence checks.
Its verified result remains available for seven days, and the activation Job logs the invocation ID. The journal is
removed at completion so the
bearer header is not retained with the result. Private activation, deactivation, ticks and
status handlers retain exclusive state mutation or shared reads as appropriate. Deployment activation alone does not
establish trading readiness.

Controller rotation commits the active successor in one exclusive transition after a fresh broker publication;
it never persists an inactive intermediate owner. The exact predecessor epoch and binding still fence the change,
and a failed or uncertain projection replays the same successor projection. A deactivation during preparation
supersedes the pending rotation. Retained `activate` and `deactivate` calls remain supported.
An unavailable initial broker capture waits for the existing serial observation owner to recover. Shared status establishes
progress only; a fresh exclusive capture confirms publication before rotation. Readiness uses bounded journaled
batches with durable waits and a new immutable-target/authority preflight between batches. The workflow can remain
pending beyond the hook client's wait and finish when the broker recovers, while a superseding deployment or
deactivation fences it. It never resumes an administratively paused Restate invocation. The broker observation
store still has one revision-bound owner: cutover can make predecessor broker reads unavailable, and the old source
does not regain trading permission. Native passes retain their independent freshness and authority checks.

Controller completion persists only an explicit absolute domain deadline. A completed pass without one waits for
a stream event. Worker completion, persistence and transport time never reset the original deadline; an elapsed wake
runs on the next bounded continuation. A failed post-pass projection check selects its explicit recovery deadline.
These wake times grant no execution authority and retain fresh reconciliation,
quote, risk and submission checks.

For equities, the first observation is one minute and two seconds after the exchange opens, bounded below
by submission opening. Continuous crypto admissions immediately use their completed rolling history; their first
observation time equals submission opening. Both calculations use the persisted `executionCalendarSchemaVersion`,
which is also exposed on the current and last cycle.
The decision deadline adds the protocol's maximum decision lag to the later of that observation and the attempt's
creation time. A later intraday attempt receives its own allowance; repeated waiting passes cannot extend it.
`bayn_cycle_first_observation_timestamp_seconds`, `bayn_cycle_decision_deadline_timestamp_seconds`,
`bayn_execution_session_ready` and `bayn_execution_session_condition` expose the same projection to monitoring.
These facts establish session operation, not economic qualification or permission to bypass native admission.

Controller `lastOutcome` distinguishes `Waiting`, `Completed`, and `Blocked`. `lastPass` retains the recovery action
and its readiness or lifecycle reason. `JEV_POSITION_HELD` identifies a reconciled position that remains open. Snapshot
waits retain the affected symbol, missing timestamp, required feature definition and window, or first available time when known.
Both `autonomousCycleLoop.lastPass` and `executionController.status.lastPass` expose these structured fields. Free-form
readiness and failure messages stay out of the public response. Historical pass observations without these details remain readable.
New tagged waiting observations require exactly one lifecycle reason or structured readiness detail. Pre-open,
mutation recovery backoff, pending broker intents, unavailable close data, and ordinary holding remain distinct.

Candidate observations are stored in the append-only `intraday_candidate_observations` table before inference proceeds.
Native content hashes bind the cycle, authority generation, protocol, snapshot manifest, raw rows, and reconciled
portfolio. Entry decisions additionally bind the completed inference batch. Price exits bind the verified liquidation rows and the policy sealed into the original entry. The corresponding log
contains that hash, candidate symbols, and source exclusions. A failed audit write fails the pass.

Protective exits also emit `bayn.jev-protective-quote-diagnostics.v1`. Its
`IEX_EXCHANGE_ONLY_NOT_NBBO` reference scope and `pairedFeedComparisonAvailable=false` make clear that the trigger was
observed on the configured exchange-only feed, not proved against a consolidated quote. The event retains the exact
quote timestamp, approximate spread in basis points, and the entry spread threshold for comparison, without quote
prices, inventory, or account identifiers. A wide spread does not suppress a protective exit: entry eligibility and
risk-reducing liquidation have different purposes. This diagnostic does not change the stop, decision identity,
quote freshness, model input, data entitlement, or broker/capital authority. Consolidated-price comparisons require
separately verified evidence and cannot be inferred from a subsequent paper fill.

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

Decision building and close preparation share the current pass's reconciliation. Additional uses check its age and
current authority version; stale evidence or changed authority requires another reconciliation. The result does not
survive the serialized pass or its broker mutation. Exact native reconciliation also fills the generation-owned
submit cache. Its account identity, reconciliation ID and authority version are checked under the final writer fence;
a newer reconciliation, later broker observation or another mutation invalidates that version. Cache misses,
discrepancies, unknown mutations, pending orders, stale evidence and authority changes deny submission. Submit consumes
the version before broker I/O; cancellation, recovery and failed reconciliation invalidate it. Replaying the consumed
reconciliation cannot refill it. Only a new native exact reconciliation supplies another version.

Transmission reads positions, open orders and account from the shared observation in one payload without broker GETs.
Position, order or cash drift from the reconciled cut denies transmission. Observed account blocks and buying power,
persisted grant, all risk limits, quote/risk expiry and the final submit deadline remain enforced. An external broker
change becomes visible on the next complete background poll; the observation is not an atomic broker lock. The
projection preserves broker order and fill source timestamps at their original precision (up to nine fractional
digits) and validates the complete payload before publishing availability. Poll and observation clocks remain
canonical millisecond UTC instants; source event precision does not change freshness or mutation fences. The
confirmation stage is `bayn.execution.broker-state-confirmation`. Its latency falls within `order_acknowledgement`,
after `SUBMIT_STARTED`; it does not account for the earlier intent-to-start delay.

The read-only forward-performance command can isolate one durable mandate. Take the exact
`capitalActivation.generationHash` from `/v1/status` when `capitalActivation._tag` is `Realized`, and run it in the
configured runtime:

```sh
node dist/forward-performance-command.js --authority-generation <generation-hash>
```

For an explicit aggregate deadline on the read-only report, append `--deadline-ms <milliseconds>` after the generation
and optional assessment arguments:

```sh
node dist/forward-performance-command.js --authority-generation <generation-hash> --deadline-ms 30000
```

The value must be a decimal integer from 1 to 2147483647. This opt-in supervises the unchanged report command in a
separate process, so CPU-bound work cannot prevent the supervisor's timer from cancelling it. The budget covers worker
startup, configuration, evidence reads, validation, encoding, private streaming capture, worker cleanup and removal of
the named capture file. The capture directory is mode `0700` and its file is mode `0600`. On deadline, cancellation sends
TERM and escalates to KILL after one second through the native process scope; scheduling and process reaping can add
time, so this is not an exact final-exit deadline. Worker failure, timeout or failure to remove named capture data publishes
no report stdout. Only a successful worker whose capture and cleanup finish within the budget publishes the exact original bytes,
including the terminal newline, from its still-open file descriptor. That final stdout transfer and descriptor close
follow the budget; downstream backpressure, a broken pipe or external termination can interrupt publication. Stdout
publication is not atomic. The deployed Linux runtime supports reading the capture after unlinking it.

`--deadline-ms` cannot be combined with `--persist-receipt` or any `--system-*` operation; invalid combinations fail
before configuration or evidence access. Without the flag, command behavior and timeout policy are unchanged. External
supervisors should allow cancellation and reaping time before killing this supervisor itself.

That invocation remains read-only. To append the generation report to the durable forward-performance receipt table,
opt in explicitly after the evidence window has closed:

```sh
node dist/forward-performance-command.js --authority-generation <generation-hash> --persist-receipt
```

Receipt persistence requires a terminal PAPER generation with sufficient, closed, exactly reconciled evidence.
Terminal means either already superseded, or still current but non-effective with the system-authored completion or
activation-expiry restriction reconciled after that restriction. The latter permits the receipt required by normal
authority rollover without first requiring rollover itself. Operator kills and retryable restrictions do not qualify.
A non-null reconciliation timestamp alone does not prove terminality. The command rejects active or unsettled
generations, open windows, unknown costs and other evidence gaps before inserting anything; use the read-only
invocation for provisional diagnostics. Terminality and the final cycle are checked inside the append transaction.
Appending a receipt does not update authority, clear a kill, or itself rearm a mandate.
An expired sandbox mandate with no execution evidence may use the existing rearm path without a profitability
receipt. That narrow exception requires a fresh exact reconciliation, a trusted flat position observation, no open
or unknown orders, and settled mutations. Any fill, accounted execution or positive filled-order quantity bound to
the generation retains the receipt requirement. Zero executions remain unqualified and never imply profitability.
The write command acquires the execution writer fence before reading report evidence and holds it through the
append and commit, so broker/accounting ingestion cannot change the snapshot between evaluation and persistence.
The fenced operation is bounded by the configured operation timeout and fails without writing when the fence is busy.
Read-only diagnostics retain their independent repeatable-read, read-only transaction and do not acquire that fence.
Within one report, completed intraday cycles with identical retrospective archive query material share the archive
watermark capture and bounded bar pages. The key includes the symbol, feed, session, calendar and exact report cutoff;
each result still verifies its own decision identity and original watermark lower bounds. No evidence or query result
is cached across reports. Retained Jev readers similarly pass one verified observation through batch and target
reconstruction; their quote binding projects already verified source rows without weakening current admission.
These optimizations do not establish that a complete report meets a requested deadline; measure that on the full cut.
Opening and closing balance queries resolve their time cuts before looking up account snapshots through the existing
account-event index. They retain the full financial history and original reconciliation and generation boundaries.
Persistence is append-only and idempotent for unchanged evidence; the creation timestamp comes from the fixed
evidence cut, not invocation time. A conflicting receipt for the same authority generation fails closed.

The command always requires `--authority-generation`; omitting `--persist-receipt` keeps that same generation scope
read-only. Programmatic account-history reports may span retired strategies and mandates and declare `ACCOUNT` scope.
Account history that includes legacy daily SIP evidence requires the historical settings described above; native-only
history does not. A scope without completed executions remains unqualified.
The command emits `bayn.forward-performance-report.v8`. Its `receipt` contains the unchanged v4 financial receipt with explicit broker cash settlement rounding;
`positionEpisodes` measures completed entry-to-flat episodes separately from fill transactions. `inferenceExpenses`
attributes ledger-verified session estimates to the requested generation. Each session retains the exact current
`matchedQuoteHashes` and `requestsWithCoverageIssues`, including the provider stage, receipt/resolution identities,
and missing quote, unverified ledger, unknown usage, or unpriced usage reason. Earlier quote versions remain verified
for integrity but do not enter the selected subtotal. The subtotal and coverage use the same complete source matcher.
These private diagnostics contain no account ID or provider request/response payload.

`executionDiagnostics` counts occurrences of the existing execution-quality failure predicates in the same
measurement pass. Its fixed 14-category vocabulary contains no identifiers, symbols, timestamps, prices or raw
evidence. Counts are predicate failures, not unique affected trades or independent root causes: a missing accounting
binding can also trigger quantity and terminal-price gaps. Existing short-circuit and continuation behavior is
unchanged, so a zero count is not proof that every downstream predicate was evaluated. `NOT_EVALUATED` retains null
transaction/fill counts when unverified decisions short-circuit measurement; `NO_EXECUTION_EVIDENCE` distinguishes
absent executions from `EVALUATED` evidence. The report hash binds these diagnostics, but the immutable v4 financial
receipt and hash do not change. No additional query, accounting write, admission decision or profitability assertion
is made.

`receiptPersistence: NOT_CHECKED` means the read-only evidence is provisional: the command has not checked whether
the generation is terminal or whether a receipt was previously saved. An active generation may legitimately have
`NO_PERSISTED_RECEIPT` in status. Only a successful `--persist-receipt` transaction changes the output marker to
`PERSISTED_TERMINAL`; failed admission emits no successful report. `reportHash` binds that marker and all diagnostics,
while the immutable per-generation receipt and its hash retain their existing schema and meaning.

`costDiagnostics` separates the generation receipt's operating-charge evidence, metered inference estimates, and
the attached assessment's registered cost scope. `receiptOperatingCharges` follows the report's declared account or
generation scope. Metered completeness applies only to `ATTACHED_SESSION_SNAPSHOTS`, with every evaluated session,
generation, and source cut listed explicitly; a partial list cannot establish coverage for an entire receipt window.
No inference sessions means `NO_SESSION_EVIDENCE`, not complete
coverage. Frozen tariff estimates remain `invoiceReconciled: false`; inspect a session with
`bayn-inference-cost --ledger-session YYYY-MM-DD`. They do not establish actual invoiced charges or fill a null
`otherChargedCostsMicros` in the generation receipt.

Without `--assessment <assessment-hash>`, assessment cost coverage is `NO_ASSESSMENT_ATTACHED`. The
registration status is `NOT_INSPECTED`; this does not assert that a registration or invoices are absent from storage.
With an attached assessment, its exact registration hash identifies the registered cost scope. The required
`bayn.operating-cost-evidence.v1` sources cover inference, data, infrastructure, and research consumption with
reviewed source artifacts and registered allocations. An attached assessment exposes incomplete candidate sessions,
their cost-report hashes, and the exact category coverage/source hashes. `operatingCostCoverage` becomes `COMPLETE`
only for a nonempty candidate session set whose costs are all complete, and applies only to `operatingCostScope`.
That assessment does not finalize an active generation or replace unknown costs in the separate generation receipt.
Position episode evidence uses `bayn.position-episode-evidence.v4`. It replays gross fills together with posted,
observed coin-fee accruals from the cumulative account history, retaining their source trades and broker snapshot
provenance in the evidence hash. Matched fee activities settle those debits without subtracting inventory again.
Episode receipt validation matches the UTC day of validated `read_evidence.sourceCreatedAt` to the accrual's verified
`settlement_date`. Every source trade must agree with that UTC cohort. Retained receipts without a source timestamp
use their recorded fee date. Inventory event order continues to use the accrual's `observedAt`.
Episode validation compares an independent cumulative PostgreSQL quantity-and-cost projection with ledger inventory;
the existing generation-scoped financial position count retains its current meaning. Either disagreement blocks measurement.
Missing coin-fee history, unmatched activities with only a trading date, ambiguous ordering, or inconsistent quantities
leave episode counts `UNDETERMINED`. Fee receipt allocation does not establish an individual trade's origin.
Measured episode counts do not remove financial settlement uncertainty or qualify profitability.

Measured evidence includes `completed` position outcomes and `bySymbol` aggregates for complete episodes wholly in
the selected authority generation. Cumulative account history establishes their boundaries, not the report's scope. Each completed outcome retains
its opening and closing transaction IDs, actual first/last fill timestamps, elapsed holding time, buy/sell fill counts,
buy notional, both-sided turnover and gross realized P&L. Partial fills remain one entry-to-flat episode; re-entry starts
a new episode. Inherited and open positions do not enter these completed-outcome statistics. Holding time uses the
original fill instants, including multi-hour and cross-date exits; no current policy deadline is imposed on history.
Per-symbol gross win/loss/flat counts, worst episode and holding distributions expose loss concentration and churn
without treating fill rows as separate trades or selecting a profitable subset after the fact.

Per-episode cost attribution is deliberately narrower than the account fee bridge. Crypto outcomes report
`ATTRIBUTED_ACCRUALS` only when every buy and sell maps uniquely to a posted native coin/cash accrual and each accrual
belongs wholly to that episode. Fill fees and those accrual expenses are summed once; missing, malformed or pooled
source linkage leaves per-episode net P&L null. `netPnlAfterAttributedCostsMicros` subtracts only those attributed costs.
Final broker activity adjustments are excluded, final execution-cost coverage remains `UNDETERMINED`, and all-in
profit remains null. Receipt matching never charges the same observed debit a second time. Equity broker activities
lack the required per-position source attribution, so their per-episode net figures remain null. An asset-level
after-attributed-cost total is emitted only when every completed episode has that attribution. These diagnostics
do not allocate residual account fees, mark open inventory, assign operating costs or change financial receipt hashes.
They run in the existing independent forward-performance command with its existing evidence reads, outside trading.

The offline regression below constructs a synthetic `0.03305` ETH buy, `0.032967375` ETH sell and observed
`0.000082625` ETH debit. It proves the reporting arithmetic only; it is not account or profitability evidence:

```sh
bun test services/bayn/src/forward-performance/position-episodes.test.ts --test-name-pattern 'closes gross fractional'
```

The default report reads performance and inference-expense records in one read-only repeatable-read PostgreSQL
transaction. `--persist-receipt` inherits the existing writer-fence transaction instead.
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
Full-session volume is requested only after the reconciliation cutoff reaches the exchange session close, even when
the trade completed earlier. Intraday reports retain those fills and accounting while full-session volume is unavailable.
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

Completion checks materialize the exact cycle and bound decision before evaluating JSON evidence, so unrelated
historical decision bodies cannot enter the completion scan. Account/time indexes support the reconciliation cutoff
and latest broker-event timestamp across every event kind. Identity, terminal-order, partial-fill, unknown-mutation
and exact-reconciliation predicates are unchanged; the indexes do not grant authority or cache mutable evidence.
Migration 0095 builds these indexes transactionally through normal startup migration. Schedule its first rollout
while the account is flat outside the regular session because ordinary index creation blocks table writes.
PostgreSQL initialization warms each client with a read-only `SELECT 1` before exposing it. An initial
`ECONNREFUSED` permits at most three attempts, one second apart. Failed acquisition scopes close before retry;
a successful client remains owned by its application scope. Composition layers do not rebuild a failed client.
Authentication failures and other errors propagate immediately. Caller statements and trading mutations retain their existing execution behavior. Persistent
connection refusal preserves the original failure and prevents startup.

Startup migrations use a private single-connection pool with a fifteen-minute overall deadline, an 895-second SQL
deadline and an 897.5-second socket inactivity deadline. That pool closes when migration completes or fails; runtime
query, socket and trading deadlines remain unchanged. The additive indexes and compatible completion predicate can remain when
rolling back the application image through Kargo; do not remove retained evidence or weaken commit durability.
The execution endpoint's startup probe allows twenty minutes for this bounded migration and initialization. Its
readiness and liveness probes retain their normal cadence after startup.

The native market recorder, execution state and financial evidence share the `bayn` PostgreSQL database in
`bayn-db`. Both replicas use existing local NVMe storage on Turin and Altra, with separate NVMe WAL volumes and
required cross-host synchronous replication. The recorder and read-only native export command use
`BAYN_POSTGRES_URL` and `/var/run/secrets/bayn/postgres/ca.crt`. The projection thread owns a single scoped connection;
application startup owns the complete schema migrations. No separate archive database or schema initializer remains.

The unified database retains every historical and current capture, original compressed byte, checksum and
ordered-prefix/append-only guard. Archive appends emit `bayn.native-arrival.append` spans including the durable
commit and retries. Retryable connection failures and statement timeouts retain the same immutable batch through
roughly one minute of reconnection attempts. Each SQL attempt and shutdown keep their existing deadlines, and the
compressed queue keeps its byte bound. Lost commit acknowledgements still reconcile the exact prefix before
returning success. TLS, checksums, backups, strategy, authority, accounting and freshness contracts are unchanged.

Each PostgreSQL instance reserves 512 MiB of shared buffers and 16 MiB of WAL buffers within its 8 GiB memory limit.
LZ4 WAL compression reduces full-page image traffic. A 4 GiB WAL checkpoint threshold and 15-minute checkpoint
interval spread checkpoint work; the existing five-minute archive timeout still bounds idle WAL archival.
These settings retain fsync, full-page writes and the synchronous standby requirement. Buffer changes require
the existing CNPG rolling restart and switchover, so deploy them while the account is flat outside the regular session.
Compare WAL buffer-full events, WAL bytes, PostgreSQL 18 I/O counters, replica flush lag and native Bayn latency
before and after rollout. A configuration revert through GitOps restores the previous settings without deleting
evidence or changing replication. Compression and larger buffers alone do not establish a faster closure path.

Migration 0127 admits only current Jev cycles (`bayn.autonomous-cycle.v4`, identity v4, policy v3, window v3).
Startup takes the cycle-writer advisory lock and an exclusive lock on `autonomous_cycles`, refuses the cutover
if any retired cycle is unfinished, and installs a write constraint without rewriting terminal history.
Promote while the account is flat outside the regular session; the table lock briefly pauses cycle reads and writes.
If the precondition fails, the transaction rolls back. Settle the existing work through its owning release before
retrying promotion. Recovery uses the previous reviewed image through Kargo; retained terminal rows and decision
codecs remain available to historical performance reporting, and the write constraint continues to reject retired cycles.

## Replay and backtesting

Native simulated broker state uses `bayn.simulated-broker-state.v7`. Fill activity IDs include a zero-padded global
execution ordinal before the order ID, so same-millisecond buys and protective sells retain their execution order
during accounting and checkpoint recovery. Earlier v6 checkpoints require their original executable; new runs and
restores accept v7 only. Production broker activity IDs and accounting ordering are unchanged.

`bayn-gap-recovery` is an offline, original-receipt decision replay command built by
`bun run --filter @proompteng/bayn build:research`. Run it with
`bun run --filter @proompteng/bayn gap:recovery`. It implements the fixed gap-recovery entry rule, with a separate
pure position-exit evaluator, but does not replace the active strategy or submit
orders. See [the gap-recovery contract](../../docs/bayn/gap-recovery.md) for exact
inputs, limitations, and the command.

`src/intraday-replay/six-bar-features.ts` extracts a separate offline research observation from an original-capture
cursor. Each candidate and SPY require six exact consecutive completed regular-session minute bars. The seven
ordered values are the candidate's one-minute close return, five-minute return relative to SPY, SPY's five-minute
return, root-sum-square of five candidate log returns, quote spread in basis points, displayed-size imbalance, and
elapsed calendar-session fraction. Missing minutes are explicit and are never filled from older bars.

The research definition requires a two-second watermark delay, zero producer-clock allowance, and quotes no older
than ten seconds. Each producer publication must precede or equal its original consumer receipt. Both symbols
require positive displayed sizes and spread at most five basis points. Candidate
trades may occur anywhere in the selected window. SPY requires post-window quotes and trades, and its trade must be
no older than ten seconds at observation. This definition is stricter than the streaming source-clock allowance.

Available values, evidenced spread or size exclusions, and unavailable inputs are separate outcomes. Each outcome
binds the definition, source, query, original receipt cut, decoded record-text hashes, and selected availability times.
`recordTextSha256` hashes the decoded UTF-8 text, which can differ from the original byte hash for malformed UTF-8.
Original-byte and receipt-coordinate verification remains a prerequisite for economic use. The in-process capture
export and interval replay APIs have been removed. New complete original intervals are unavailable until the independent
[market-data archive](../../docs/bayn/market-data-archive.md) passes its source and coverage checks. `openBacktestSource`
validates the admitted offline source; it cannot establish an unobserved trading arrival or complete a missing interval.
Malformed inputs fail with a typed error. The result remains `UNQUALIFIED` with controller coverage `UNKNOWN`.
It does not prove capture completeness, train a model, produce an executable snapshot, or change Jev's observed-history
contract. Capture interval verification remains the caller's responsibility before economic research.

The [offline Ridge pair](../../docs/bayn/six-bar-ridge.md#offline-paired-portfolio) uses explicitly admitted
control-study input v10 with deterministic entry and artifact v2. It compares the seven-feature score with the genuine training-only
day-weighted target mean under the same fixed-principal budget and mechanical execution rules. Native
First-completed-minute eligibility is unchanged. It uses original-capture six-bar observations and the
existing serial portfolio; missing inputs remain incomplete even when the baseline would choose cash. It grants
no production registration, qualification or capital authority.

### Bounded mechanical control and turnover comparison

The sole development contract is `bayn.control-study-input.v10`, with explicit `entry`, `management`,
`turnoverPolicy`, `costObjective`, `riskEnvironment` and `openingPeakEquityMicros`. The optional `riskPolicy` pins
approved native policy material; opening capture resolves the request's hash and binding carries that policy into replay.
Preparation validates the native policy before rebinding only its account ID to the simulation account, so historical v4
mandates retain their limits. Without an explicit policy, the risk environment selects the current native live or sandbox
profile instead of silently defaulting to live limits for a PAPER comparison. It retains the deterministic
controls, optional frozen residual-shock candidate and Ridge pair.
Older development input versions are rejected. See [control portfolios](../../docs/bayn/control-portfolios.md).

`entry: "JEV"` adds a native Jev entry portfolio beside deterministic controls and requires mechanical exits and
matching native allocation. It evaluates the native model against its own flat ledger, retains each observation,
batch and committed decision, and advances market time through measured provider and fsync journal work before
order pricing. It retains costs for abstentions and incomplete model work. This is an independent policy comparison;
it does not reuse historical model answers or establish profitability. A new evidence directory is required.

`entry: "DETERMINISTIC"` with `management: "MECHANICAL"` creates no provider client. Jev is available only for
entry selection. Independent controls share their explicit IOC execution, finite liquidity, fees, turnover,
loss/drawdown, stop, holding and close rules. They do not qualify the v18 native broker lifecycle or grant authority.

`turnoverPolicy: "ENTRY_AND_EXPECTED_EXIT"` reserves both entry notional and a modeled exit allowance;
`IMMEDIATE_ADJUSTMENT` uses immediate entry admission. These scenario choices cannot block mandatory reducing exits
or guarantee a bound on unknown future exit prices. Freeze them before evaluating outcomes.

Freeze the input, source receipt, exact source revision or file-hash snapshot, and comparison policy before results.
Run each registered input with `--input-sha256` and `--source-receipt-sha256`, preserving failed runs and distinct
output files. Current asset eligibility must be labeled counterfactual rather than historical. A zero allocated data
charge is an explicit incremental-cost scenario, not proof of zero operating costs. Apply further cost/latency stress
without selecting favorable dates or erasing missing observations. Development comparisons do not satisfy the frozen
prospective qualification protocol and never activate a different model, prompt, threshold or trading policy.

For the bounded paired Jev-versus-relative-momentum experiment with shared protective exits, abstentions,
cost coverage and prospective completeness gates, use the
[matched entry study](../../docs/bayn/matched-entry-study.md). It remains an offline opportunity test and grants no
strategy promotion or trading authority.

The [retained session export](../../docs/bayn/study-evidence-export.md) keeps the original v1 batch inventory and a v2
opportunity/cost companion. Standalone protection proof is captured from the original intent, exact risk approval
and historical reconciliation within per-cycle row and byte bounds, then reproduced by the native execution verifier.
Missing proof remains an explicit gap; contradictory proof fails. Complete recorded joins do not independently
verify the ledger, reconcile invoices or establish all-in profit.

For a development comparison of retained Jev entry signals against fixed deterministic rules, use the
[signal study command](../../docs/bayn/jev-signal-study.md). It verifies the original source and measures common
15-minute hypothetical outcomes. It is a signal screen, and its overlapping hypotheses do not form a portfolio
backtest or satisfy the migration's economic acceptance protocol.

The separate [control portfolio command](../../docs/bayn/control-portfolios.md) evaluates full-session deterministic
development portfolios with independent cash and positions, repeated entries, partial exits, and shared execution
accounting. External data expenses reduce reported net equity without changing broker cash, sizing or risk, as in
native replay. The control command accepts only `MECHANICAL` management. Its independent fixed exit profile is an
offline comparison and does not qualify the active v18 strategy or its native broker lifecycle. Retired research model
management and its duplicate execution implementation have been removed. Timing and execution assumptions still
require calibration before prospective acceptance.

Production execution and simulation use `makeTradingEngine`. The engine constructs the execution program and
recovery-first cycle driver from one strategy and risk policy. The broker, market-data source, clock, and isolated
persistence are environment bindings. Replay does not implement its own strategy selection, sizing, order planning,
or accounting coordinator.

The replay broker retains equity LIMIT/DAY orders after an unmatched or partial arrival. Each newly available
accepted quote can fill the remaining quantity until cancellation, full fill or the verified broker session end.
Pre-market and post-market quotes retain their native IEX clock-segment identity. The retained source delivers
quotes in availability order, including brief crossings between controller polls; consuming the verification tail
after trading ends cannot mutate the broker. Crypto LIMIT/IOC orders evaluate their arrival once and cancel any
remainder through the same quote economics and accounting. Displayed liquidity is shared across orders and retries.

Replay checkpoint v10 and broker state v6 retain every quote execution and uniquely identify partial-fill and fee
activities and the first broker arrival. Routing quotes cannot execute queued orders or children before activation. Native bracket children remain held until a complete parent fill. OCO groups reduce stop quantity after
a partial target, cancel remaining siblings, and retain stop-limit trigger state through restart. Crypto GTC stops
persist across UTC dates. This sequential quote model cannot qualify venue cancellation races. Restoration reconstructs cumulative order quantities, average prices, cash, inventory, fees and native
activities before exposing the broker. Account inception is retained across restart so regular-close equity references cannot be fabricated before the simulated account began. Each fill selects its retained quote by topic, partition, offset and availability
time, including separate quotes in the same millisecond. Replay cancellations use the shared Alpaca HTTP 204 response
decoder and empty-response hash. Earlier replay checkpoint schemas cannot resume this contract. Missing
original arrival receipts and PAPER's different liquidity assumptions still prevent claiming historical live-fill parity.

Regular-close reference equity retains its valuation qualification through restart. A stale quote or empty bid
still supplies the retained accounting mark for the next day's broker reference, but leaves economic qualification
incomplete for that reporting cut and subsequent cuts. A later fresh quote cannot qualify the missing historical evidence.

The simulated cash account enables crypto when its supplied assets include crypto instruments. Its non-marginable
buying power follows ledger cash through fills and fees, so the native submission guard can enforce crypto eligibility
and available cash. These account conditions are simulation assumptions, not historical account-entitlement evidence.

`backtest-command.js` runs one continuous interval through that engine, including nights and weekends. One simulated
broker, account, portfolio, PostgreSQL database, and TigerBeetle ledger span the entire run. Cash, positions, fees,
risk history, and unresolved orders carry across UTC reporting boundaries. The broker calendar still controls equity
sessions and expiry. It does not close the crypto market. Separate experiments use separate run identities and fresh databases.

```sh
bun run --filter @proompteng/bayn build:research
BAYN_BACKTEST_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:5432/bayn_replay \
BAYN_BACKTEST_TIGERBEETLE_ADDRESS=127.0.0.1:53000 \
BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID=20912 \
BAYN_BACKTEST_TIGERBEETLE_LEDGER=70912 \
node services/bayn/dist/research/backtest-command.js \
  --input backtest.json --arrivals source.ndjson.gz \
  --source-receipt source-receipt.json --source-receipt-sha256 "$SOURCE_RECEIPT_SHA256" --output new-run-directory
```

Set `BAYN_JEV_API_KEY` and `BAYN_EGRESS_PROXY` through the existing protected environment. Current
requests use `bayn.backtest.v11`, with an `inference` object containing `mode: "measured-providers"`,
`models: {"jev": "jev-1.14.0"}`, `inputDefinition: "bayn.jev-entry-state.v24"` and a positive `maximumCalls`
shared by every Jev stage. The input binds `jevInstructionsHash` to the exact compiled instruction document.
`bayn-backtest --instructions` reports it. `costs` uses `bayn.inference-rate-card.v1` with effective-dated provider/model
rates. Candidate and chart ablation require only Jev tariffs; deterministic momentum requires none. Current preparation
selects the registered policy's tariffs. Original OpenAI receipts retain their original cache tariffs for financial
reading only. A call without its rate remains an unresolved expense and cannot establish complete economics.
The input also declares
`allocatedDataCostPerSessionMicros`, either a priced integer-string allocation or explicit `null` when unknown.
An unknown allocation preserves execution evidence while making sessions and net results incomplete; it never
becomes a zero expense. Control comparisons and net-label training require a priced allocation. Changing these
assumptions changes the run identity.

The provider uses an independent live clock. Replay retains original provider requests, responses and timestamps
in `inference-calls.ndjson` before advancing market and database time. Each call identifies its provider stage
and remaining deadline. Chart inference, the durable handoff and Jev share the original ten-second entry window;
the second provider receives only the remaining time. Concurrent calls share elapsed time. Native
PostgreSQL batch and evaluation stores retain the mapped evidence and enforce the original inference deadline.
Failed or interrupted calls with unresolved charges make the cost result incomplete. Known charges use the declared
tariff with each call rounded upward to one micro-dollar. Invoice verification remains required for qualification.

Native replay uses the same protected CONNECT-proxy transport as production for both providers. Its provider-call ceiling counts dispatch
attempts, including failures and interrupted calls, and never refunds or retries an exhausted slot. Provider timing
still includes the actual test host and network path; original-session timing and production capacity require
independent verification. The complete report is written privately to `report.json`; stdout contains a small summary.

Final authorization samples measured elapsed time after provider, persistence, writer-lock, grant and broker reads.
Every replay reconciliation, including those inside the cycle driver, uses that measured clock after ingestion.
During measured operations, the replay account's transaction-acceptance clock advances with PostgreSQL wall time,
including evidence queries, insertions and work in the enclosing transaction. Recorded observation timestamps retain
their synchronized replay time. Reconciliation returns that published source timestamp; it cannot stamp evidence
ahead of the account and market-data clocks. Provider synchronization advances deadlines without parsing historical
arrivals. Source publication waits until inference has finished; its file-processing time is excluded from both
elapsed-time and PostgreSQL measurements. Native operation timers pause at that same boundary and resume with their
remaining duration; provider request timers retain their independent wall clock. The database clock resumes even
when parsing fails or is interrupted. Provider, persistence and clock-synchronization work remain measured. Completing
the measured scope retains elapsed time and publishes arrivals through that timestamp before scheduling or valuation.
The source reader excludes time only while reading a chunk or consuming due arrivals. Polls between cached future
arrivals and after verified EOF retain their broker deadline ticks without pausing either measured clock. This avoids
pause/resume database writes on empty source checks. Every native poll, causal arrival, reconciliation, financial
record and original operation deadline remains required. A source clock failure prevents further advancement.
Deferred exit deadlines therefore still include native work before transaction acceptance.
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
The successor supplies scheduling context only. The declared interval controls execution and source coverage.

Every input uses `bayn.backtest-source.v2`, a complete source file, and a separately pinned source receipt. Captured Kafka and historical REST declare different transport provenance. Hashes, source
coordinates, the complete `marketSources` inventory, record ordering, and interval coverage must validate before database setup. A native capture retains every configured market in its original global consumer sequence. Capture receipts
establish the retained stream's bounds; they do not establish historical liquidity or original delivery for REST data.
See the [streaming guide](src/market-data/streaming/README.md) for source capture and Dorvud feature regeneration.

Each pass records the engine's decision/cycle result and simulated broker state. Entry and position-management waits
retain typed readiness: pending, rejected or expired inference and unavailable market inputs count as missing decision
data, even when a later deterministic exit succeeds. A verified model hold remains distinct from unavailable evidence.
The final `bayn.backtest-report.v5`
retains every session's schedule, closing broker equity, net equity after known model and allocated data costs,
and reconciliation, plus cumulative net equity change, observed peak
and drawdown, final broker orders/fills/positions, durable accounting counts, and input identities. The output keeps
the exact input, source receipt, pass log, decoded entry and closing decisions, accounting rows with full integer precision, and hashes. Valuations retain the last observed valid bid, its age, and whether displayed bid liquidity was positive; that accounting mark never relaxes executable-quote freshness. A stale or zero-liquidity held-position mark stays in the pass log for diagnosis but counts as a missing qualifying valuation, so the session cannot report complete economics. The same check applies at session close: an unqualified closing mark remains visible in closing equity but cannot update reported peak or drawdown. Preserve the source file and both databases with the report.

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
   One-sided quotes retain the provider's zero price and size, including an absent ask. Native replay records these
   quotes as rejected input, so they cannot supply executable prices or qualify an affected observation window.
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

### Property tests and structured fuzzing

`bun run --cwd services/bayn test:property` runs the fixed seed `20261003` with 100 generated cases per property
(20 for full streaming snapshots and acceptance bootstraps). These tests also run in the normal `test` command and
existing Bayn CI gate.
The generators produce valid archive rows, source envelopes, risk entries, and partial-fill lifecycles before
mutating them. They cover strict decoding and recovery after rejection, canonical evidence identity, physical
row-order-independent retained replay, one-atom quantity and one-micro notional boundaries, cash and cost-basis conservation,
authority/freshness failures, and exact decimal acceptance thresholds against an independent bootstrap oracle.
Critical-path campaigns also exercise the shared equity/BTC/ETH/SOL planner's precision, liquidity and capital
bounds; exact submission cutoffs; crash recovery before and after entry-lease expiry; durable decision retries;
and observed crypto coin/cash fee bounds with stable ledger identities across repeated broker observations.
Sparse history generators vary real completed-bar coverage and late historical arrivals, require the latest
candidate and benchmark minute, reject future arrivals, and reproduce immutable snapshot evidence and common
momentum references. First-minute exchange queries clamp history to the actual session open.
All data is synthetic; no broker, database, or live account is contacted.

Run a longer, reproducible 1,000-case-per-property campaign with a new seed:

```sh
BAYN_PROPERTY_SEED=123456789 bun run --cwd services/bayn test:fuzz
# Or choose an explicit size (1–100000 cases per property):
BAYN_PROPERTY_SEED=123456789 BAYN_PROPERTY_RUNS=5000 bun run --cwd services/bayn test:property
```

Each property has a 120-second campaign budget; interruption fails rather than silently reducing coverage.
The command allows 150 seconds per test. `fast-check` shrinks failures and reports their seed, path and minimal
counterexample. The same information is retained under `services/bayn/.fuzz-failures/` (git-ignored).
Replay one failure using the reported seed/path and the exact test name, for example:

```sh
cd services/bayn
BAYN_PROPERTY_SEED=123456789 BAYN_PROPERTY_PATH='0:1:2' bun test src/intraday-replay/ledger.property.test.ts \
  --test-name-pattern 'property: a one-atom oversell' --timeout 150000
```

Never apply a shrink path to the whole suite. After fixing a discovered product defect, keep the minimized
synthetic case as an ordinary named regression test so changing the campaign seed cannot lose coverage.
`fast-check` is an exact, direct development dependency for shrinking and replay; it is not in the runtime image.

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn test:postgres
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn lint
bun run --filter @proompteng/bayn lint:oxlint
bun run --filter @proompteng/bayn lint:oxlint:type
bun run --filter @proompteng/bayn build
```

CI partitions the complete unit suite into four duration-balanced Bun shards with two isolated workers per shard.
These parallel shards use Bun 1.4.3 for its isolated-file finalizer fixes. See the
[upstream fixes](https://bun.sh/blog/bun-v1.4.3#bun-test).
The CI default test budget is 15 seconds for full research fixtures on shared runners; explicit test budgets still apply.
Effect compatibility and broker sandbox tests run in this suite with broker credentials removed. PostgreSQL uses
four sequential shards, each with its own disposable database; `bun run --filter @proompteng/bayn test:postgres 1/4`
runs one shard locally. Omitting the shard runs the complete PostgreSQL suite. Never run concurrent shards against
the same database. ClickHouse/Java archive checks and PostgreSQL/TigerBeetle ledger checks run in separate jobs.
The release gate requires every shard and integration job to pass.

Streaming failure integration runs in a separate required job with disposable PostgreSQL, Restate 1.8.1 and Kafka.
Run `bash services/bayn/scripts/test-streaming-integrations.sh` from a local Docker host using the pinned toolchain.
It exercises admitted inference retries, obsolete-poll retirement on a fresh Restate instance, and the pinned Kafka
ingress's outage/rebalance recovery. The PostgreSQL runner also executes the expense LISTEN lifecycle suite. These
runners validate each reported file's JUnit cases with Python 3 and reject required files that are absent or entirely
skipped. Normal unit runs continue to skip integrations whose isolated services were not configured. The same
required jobs run through the normal main image-validation workflow before publication.

With `BAYN_TEST_POSTGRES_URL` pointing to a disposable `bayn_test` database and
`BAYN_TEST_TIGERBEETLE_ADDRESS` pointing to an isolated TigerBeetle instance, run
`bun run --filter @proompteng/bayn test:ledger`. CI runs `runtime`, `backtest`, `latency-jev`, `latency-ablation`,
`latency-momentum`, `latency-momentum-trading`, `frozen-control`, `restart`, and `inference` in separate jobs, each with
its own disposable PostgreSQL and TigerBeetle. The four twenty-session latency cases retain their native polling,
assertions and ten-minute case budgets without sharing one fifteen-minute CI job. Append a group name to run it
locally; omitting the name runs all groups sequentially. Never run groups concurrently against the same stores.
Native latency replay diagnostics go to `node_modules/.cache/bayn-latency`; CI retains the full files as artifacts
instead of streaming every accelerated replay pass to its console. Phase progress and test failures remain visible.
The disposable diagnostic executable also retains cumulative host-clock timings for seventeen fixed reconciliation,
cycle and PostgreSQL stages. It emits a checkpoint every 1,024 reconciliations, with at most 31 checkpoints and one
terminal summary. Counts distinguish completion, failure and interruption; totals and maxima are inclusive, so nested
stages overlap. Only stage names and numeric aggregates are emitted, never span payloads. Checkpoints remain useful
when the case deadline kills the child before its terminal summary. The production executable and polling are unchanged.
The release gate requires every group to pass. The suite covers native Jev entry,
zero and partial fills, DAY cancellation and cycle completion, process death/restart, accounting and inference
expenses. The seven durable-broker cases alone do not cover the native production lifecycle.
Measured entry/exit replays supply improving arrival quotes under the frozen inference-ask ceiling, including
partial-fill and re-entry cases with modeled slippage. Every measured buy fill must stay within its submitted limit;
adverse arrival quotes remain unfilled and retain separate broker coverage.

PostgreSQL tests require an isolated database whose name ends in `_test`; never point them at a live Bayn database.

The optional cumulative-ledger integration test requires an isolated TigerBeetle 0.17.9 server on loopback with cluster
ID `2001`. It posts 10,500 synthetic transfers, verifies account and performance evidence, and supports rerunning against
the same data after restarting the server. Run it from the repository root:

```sh
BAYN_TEST_TIGERBEETLE_ADDRESS=127.0.0.1:39701 bun test services/bayn/src/ledger/account-history.test.ts
```

Historical development candidates are terminal, non-executable records summarized in
[`docs/bayn/candidate-terminal-history.md`](../../docs/bayn/candidate-terminal-history.md).

OTLP failure warnings include consecutive failed attempts. The exporter logs a successful request after failures,
with the attempt count and elapsed outage time. This confirms transport recovery for that request, not completeness
of spans during the outage. Broker projection rejection logs distinguish stale, future, account and chronology
failures with observation age, without recording account identifiers or payloads.

## Independent Jev instruction research

The [GEPA optimizer](../../docs/bayn/jev-optimization.md) proposes the shared evidence instruction
consumed by every proposal-specific atomic Jev question. The protocol identity includes that exact instruction. It uses one pinned GEPA engine and explicit native financial outcomes. The former Harness2
runner and active factor/editor contracts are removed. Jev remains the typed System One model. The selected shared Flamingo or native OpenCode free endpoint only edits
the question document through the signed research workflow. The isolated CPU gateway `opencode-research` in
namespace `opencode` retains one session per study,
with one hosted call per proposal and no paid fallback. Its actual provider input, raw response and source/configuration
identity travel in the verified research receipt, with separate gateway and worker source revisions.
See the runbook for native session and budget enforcement and the [standalone server](../opencode/README.md)
for development access and the verified state migration.

The published research image supplies `bayn-gepa`, `bayn-gepa-native`, `bayn-jev-evaluate` and `bayn-control-study`.
`bayn-jev-evaluate` is offline and never acquires provider credentials. Release and health verification must not issue
paid inference outside admitted trading work or explicitly budgeted research with durable requests and receipts.
Research variants change one validated data module and retain exact source, dependency, request/response, cost and
execution evidence. The runner reserves paid calls before dispatch, rejects ambiguous retries, keeps evaluation
feedback out of proposals and retains an unchanged-question repeat. Existing numerical controls provide a separate
common mechanical-exit comparison. Unknown costs remain explicit; all outputs are unqualified and grant no capital authority.
Use the runbook for existing-data manifests, isolated local accounting targets, compiler source mounts and receipts.

### Research capture storage

GEPA uses `BAYN_RESEARCH_CAPTURE_BUCKET` and `BAYN_RESEARCH_CAPTURE_ENDPOINT` with the existing research storage
identity. Model and research HTTP clients use `BAYN_EGRESS_PROXY`. These settings retain their existing destinations.
The unconsumed SEC/macro collector is removed; previously captured public-source objects remain in the private bucket.

### Continuous-market reporting and replay

The forward-performance reader uses the same snapshot calendar and feed contract as native execution. Crypto
reports retain `us`, `real_time_crypto`, fractional quantities, and the finite execution window. Volume evidence v2
uses complete recorded minute bars within that window; it does not label a short crypto cycle as a whole-day volume.
Missing bars leave capacity unknown. Retained reports keep their original hashes.
The archive adapter reads Dorvud's native `signal.crypto_market_events_v1` into the same bar, quote, trade, and
watermark contracts used by the reporter. It preserves original numeric tokens for fractional volume and terminal
prices, applies the report ingestion cutoff, and counts only complete minutes in the archive row budget.
Bayn's existing read-only ClickHouse identity requires `SELECT` on that one crypto source table.

USD crypto `CFEE` receipts carry a cash debit without coin fields. Regulatory `FEE` receipts cannot settle crypto
accruals. Crypto settlement cohorts derive their UTC date from every exact retained source fill; the original stored
accrual metadata and hashes remain immutable. Migration 105 adds verified, immutable corrections for regulatory
receipts previously matched to crypto accruals. The native reconciliation path posts the compensating ledger debit
with a deterministic identifier, then matches the actual crypto receipt. Retries verify every original and correction
plan. Pending corrections and corrections posted after a report cut prevent complete accounting evidence.
Cash receipts release only the amount actually covered, including partial settlement of a pooled UTC cohort.
Migration 106 prevents reporting precision from authorizing a larger release. An already posted overrelease receives
a deterministic v2 compensating debit for the excess alone; its original match, provider hash, and ledger plan stay
immutable. The original v1 regulatory correction evidence remains verifiable. Outstanding accruals and the cash
reporting residual remain until the entire cohort settles.
Replay checkpoint v3 retains the same crypto cash-fee kind; earlier checkpoint versions are rejected.
Fee history uses the daily non-trade query contract with pagination. Trade timestamp filters are rejected because
Alpaca can omit current-day crypto receipts when `until` is present. Native capture validates every fee date against
its UTC cut and compares the complete before/after history before persisting or admitting a trade.
Cash-yield evidence v3 binds the baseline, opening and closing reporting residuals to posted accruals and settlements
visible at each cut. Reporting uses the native residual calculation and applies only the change between cuts. It
does not post a transfer or treat a reporting-precision difference as income. Earlier evidence versions are rejected.
Migration 107 records an immutable database-clock acknowledgement only after the native journal verifies each fee
or accrual plan. A failed post leaves no acknowledgement; a retry or retained-plan verification acknowledges the
actual successful check without backdating it to the provider observation. Historical cuts without an acknowledgement
by that cut withhold cash-yield evidence and financial qualification. Existing ledger records and provider clocks
remain immutable; an earlier posting time is never inferred from a later successful verification.
Current account reconciliation bounds cumulative ledger receipts and net inventory independently of the selected
generation's performance cut. Position episode evidence v4 binds that current account cut and includes coin-fee
inventory debits. A fully accrued crypto cash receipt adds no incremental generation expense; its original and
correction plans remain in the complete account ledger, while the source-bound accrual supplies the generation cost.
Unallocated incremental fees and missing historical posting acknowledgements still prevent financial qualification.
The forward-performance command requires an explicit authority generation. The unbounded account-history command
has been removed; cumulative accounting and ledger verification still accompany every scoped report.

Cash reconciliation retains the latest posted, unsettled cash-fee observation's reporting residual when projecting
later fills. The residual changes only the comparison at the broker's declared precision; it never posts a cash or
fee adjustment. Complete fee-cohort settlement retires it.

Alpaca posts each fill's cash movement at the precision retained with its account snapshot. Migration 112 adds
append-only `broker_cash_settlements`: each record binds the original fill transaction and accounting receipt to
that observed precision. Reconciliation prepares the deterministic rounding difference, commits its evidence,
and posts it through the existing journal before verifying the complete account. Original fills, fees and inventory
cost remain precise and immutable. Failed posts or acknowledgements resume with the same transfer identities.
An unexplained cash difference still blocks trading; the settlement calculation accepts no target balance.
Accounting-state hashes use v4 and bind both the fee reporting residual and every cash settlement. Financial
receipts use v4 and report `cashSettlementRoundingMicros` separately from gross trade P&L, fees and cash yield;
net income includes it only for the source transaction's authority generation.

The model-action cutover may migrate an already restricted, flat OBSERVE account while reconciliation is inexact,
so native recovery can repair its ledger. It preserves that restriction's reason and active kill switch. Only an
effective PAPER account or recognized predecessor cutover receives `BLOCKED_STRATEGY_PROTOCOL_CUTOVER`; operator
kills and unknown restrictions never become automatically recoverable. PAPER execution still requires exact
reconciliation and a fresh protocol-bound capital activation.
An inexact close reconciliation returns `CLOSE_RECONCILIATION_PENDING` at the regular reconciliation cadence before
reading archive data or binding a liquidation document; exact evidence resumes the same close path.

Each crypto observation evaluates BTC/USD, ETH/USD, and SOL/USD together. Candidate exclusions preserve independent
opportunities and required benchmark failures. Snapshot failure logs include per-symbol bar coverage, quote age, and
matching feature availability. Admission, inference ranking, account allocation, risk checks, and the execution writer
remain shared with equities.

Research inputs require frozen instrument metadata. The single replay execution core handles IOC orders and market
recovery; simulated broker checkpoint v3 reconstructs coin and cash fee activities before exposing restored state.
Study input v2 and checkpoint v3 replace their prior contracts. Existing frozen studies keep their original revision
and receipts; reruns require newly registered inputs and cannot inherit qualification from an older report. New native
management observations require `entryInventoryDebit`, verified from posted accounting even when both values are zero.
Historical observations remain immutable; readers reject records missing this evidence instead of inventing a fee debit.
The [matched comparison](../../docs/bayn/matched-entry-study.md) retains its five-session, twenty-different-selection,
original timing, capacity, and complete-cost requirements. Missing evidence cannot qualify Jev.

Equities use Alpaca's full provider calendar intersected with the entitled IEX data interval, 08:00–17:00
America/New_York. Provider regular and extended bounds remain in the hashed calendar v2 evidence; DST, holidays
and early closes follow that source. The shared order loop submits stock LIMIT/DAY with `extended_hours=true`
and crypto LIMIT/IOC with `extended_hours=false`. An acknowledged open order is canceled through the same durable
mutation coordinator when its original approval or submission window expires. Known partial fills retain their
original accounting. Whole-share equity liquidation during an archive outage also uses a bounded LIMIT/DAY order.

Dorvud's observed-window and technical definitions v2 isolate the 08:00, 09:30 and 16:00 clock segments. Regular
indicator math is unchanged, sparse intervals remain missing, and the first completed minute can authorize
observation without waiting thirty minutes. Extended transport health requires quote delivery while retaining
per-symbol gaps as diagnostics; absent trade prints are not heartbeat failures. Calendar eligibility and candidate
quote, trade and feature checks still govern every order.
Equity admission starts after that first completed minute and its existing decision delay; the unused-entry lease
remains 60 seconds. Continuous markets remain eligible before that boundary.

Migrations 113 and 114 installed the extended-session execution contract and replaced the IOC-only completion
predicate with the shared strict DAY/IOC proof, including the renamed partial-fill helper. Migration 140 owns the
current economic-plan v18 cutover. Verify these migrations, flat settled inventory, terminal orders and fresh exact
reconciliation before activating a new same-account v18 PAPER mandate against its verified published image.
Operator restrictions and immutable financial evidence remain enforced throughout OBSERVE recovery.
See the [Alpaca hours investigation](../../docs/bayn/alpaca-equity-hours-2026-10-16.md) for feed entitlements and
current execution limits. This migration grants no live capital authority.

Current equity fee modeling uses the registered effective-dated schedule and an explicit New York execution date.
The documented TAF pause applies from October 1 through December 31, 2026. The dated schedule currently covers
July 2026 through December 2028, including the published January 2027 resumption; unsupported equity dates fail with an explicit missing-schedule error. Crypto fees
remain independent of this equity schedule. Actual broker expense evidence is separate from modeled planning costs.
Retained fixed schedules reproduce original financial evidence without applying the new override retroactively.
The sources are [Alpaca's October 12 fee schedule](https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf)
and [SEC release 34-106409](https://www.sec.gov/files/rules/sro/finra/2026/34-106409.pdf).

The [published resumption and 2027–2028 rates](https://www.sec.gov/files/rules/sro/finra/2026/34-106409-ex5.pdf)
restore $0.000195 per share with a $9.79 cap. The dated model withholds the changed-rate period beginning in 2029.
