# Bayn

Bayn is a single-writer execution service for equities and continuous USD crypto markets. Restate schedules one account-keyed controller, pure TypeScript
decides what should happen, Effect interprets one bounded pass, PostgreSQL stores trading truth, TigerBeetle stores
accounting truth, and the broker adapter performs account-environment-neutral execution.

The optional [OHLCV + image dual-signal shadow command](../../docs/bayn/dual-signal-shadow.md) compares Jev and
OpenAI Decisions over correlated views of the same market data without changing order authority.

Migration 134 removed six empty retired tables and the obsolete broker-error/rate-limit event variants. It refused
populated retired evidence and preserved active broker failures, accounting and replay. `tools/audit-database.sql`
provides bounded read-only table sizes, exact retirement counts and migration readback.

Internal construction and canonical hashing use the typed `Result` APIs. Eager
validation stays in `Result`; runtime callers lift failures into their owning
Effect error channel and retain the cause. Tests assert expected success locally
with `Result.getOrThrow`. Production throwing compatibility exports and test-only
Effect decoder wrappers have been removed; tests decode the shared schemas with
the same strict parse options. Immutable historical documents and the decoders
used to read them remain supported.

New target planning accepts only quote-bound inputs with an explicit allocation, verified bid/ask prices and
per-symbol liquidity limits. Retired `bayn.paper-target-planner-input.v1` and `v2` inputs cannot construct new plans;
there is no full-equity or daily-reference-price fallback. Existing target-plan output decoding remains available
for immutable historical evidence. Financial reports retain unsupported historical decision identities and accounting
totals, while withholding unverifiable execution measurements rather than replaying retired planning contracts.

Execution deadlines preserve the reconciliation preflight boundary. If the outer generation deadline interrupts
preflight first, the pass reports a reconciliation failure and retries with a fresh broker reconciliation. It cannot
enter cycle execution. Timeouts after that boundary retain fail-closed mutation authority restrictions. See the
[October 17 runtime and crypto entry investigation](../../docs/bayn/crypto-entry-research-2026-10-17.md) for the
reproduction, cost evidence and research limitations; this recovery does not establish profitable trading.

Live market-data reference verification retains a bounded fingerprint of each fully verified captured snapshot.
An exact match across the manifest, bars, quotes, trades and latest quotes reuses that capture's source proof without
reconstructing it again after entry pricing. Changed data still requires full replay verification; unobserved cuts
also require an exact committed database reference. Retained and returned references have separate manifest copies.
Quote age, inference expiry, current authority, risk evaluation and durable decision guards remain independent checks.

Jev batch admission detaches the selected source observation before reproducing it once, then carries that private
verified graph into persistence. Mutating a caller or database-result alias during an awaited read cannot change the
verified bytes or their sealed hash. The writer still checks the cycle, authority generation, exact reconciliation
and portfolio sources in its transaction before
recording the observation and request claims. Admission keeps its original deadline checks before and after that work;
reusing the verified observation does not extend the inference window or authorize an incomplete batch.

A preflight failure can also restrict a generation whose earlier cycles all finished without targets. Native recovery
accepts those completed decisions only when every generation-bound decision matches a terminal `NO_TRADE` cycle's
account, plan, strategy, protocol, snapshot and submission deadline with empty intent lists, and the generation has
no intents or active cycles. Native recovery settles and reconciles a restricted generation before running another cycle.
An already settled, flat account rotates through clear OBSERVE and resumes the approved PAPER mandate without an extra
close-only cycle pass. Unsettled broker work continues through close-only recovery. The same settlement check runs
after an actual close-only cycle pass, so newly resolved broker work can finish its generation handoff immediately.
Operator holds remain restricted.
A prior no-trade decision cannot cover an incomplete or planned execution.
Decision creation must also fall within the cycle's durable creation, submission-open and last-update bounds, as
required by normal cycle recovery.

The source selects `jev` protocol v20 / signal state v17. Jev separately judges the current setup and whether an actual
complete entry/stop/target trade is supported after costs within the holding deadline. Both answers must support entry:
`setup=upward` and a supplied plan selected by `action`. An adverse or unclear setup rejects a plan, and plan abstention rejects an upward
setup. Code supplies a bounded menu of market-price targets and per-stop net-reward scenarios whose conservative modeled
profit covers the modeled loss. It labels the hypothetical scenarios explicitly and validates/funds every candidate
before inference. A price above a recent high is
an order proposal, never fabricated market history. The stop and target remain one complete plan, with no default
exit selected by code, and no momentum prefilter. Costs, exposure sizing, account risk limits and broker protection
remain enforced. See [strategy protection](../../docs/bayn/strategy-protection.md) for candidate construction, venue
constraints and the hard migration. These model decisions have no demonstrated profitable edge.

Observed bar prices retain provider precision in source evidence and model context. Complete-plan construction rounds
these historical prices down to micros before applying instrument ticks. Broker quotes and executable prices keep
their separate precision checks; a provider bar with more than nine decimal places cannot invalidate the whole batch.

For flat PAPER accounts, the same reconciled daily-loss and all-time drawdown limits also run before market-data
reads and Jev batch admission. `ACCOUNT_PROTECTION` readiness names the existing limit that prevents an entry;
the execution-session status and metric report `BLOCKED`, not an input outage. It does not create a model
abstention or a risk-approved order. Position management and reducing exits continue
through their existing path, and full submission-time risk checks still run for every order. Read-only OBSERVE
research is unaffected. Capital activation and recovery retain the account's original peak and daily turnover.

Durable pass readers and public status support optional typed `accountProtectionReasons`:
`DAILY_LOSS_EXCEEDED`, `DRAWDOWN_EXCEEDED`, or both. Historical observations without this field remain readable.
This reader-first rollout keeps both entry writers on their existing shape; enable the field only after the
updated readers are deployed, so older status pods can decode shared controller evidence during the transition.

After unfinished work is recovered or an expired unused lease is terminalized, an exact flat reconciliation
preflight can hold entry admission before creating another cycle. The existing daily-loss and drawdown comparisons
still permit equality. This cycle-free `ADMISSION_WAITING` result binds the authority generation and update,
reconciliation, account trading date and earliest broker-evidence expiry. Public execution readiness reports
`BLOCKED` only while that proof still matches the current account state; an older closed cycle cannot hide it.
Missing or expired preflight evidence follows the existing admission and decision checks. The check adds no
database or broker reads, retains normal reconciliation and observation cadence, and never suppresses a bound
cycle's position management or recovery. No protection result is cached between passes or used to grant authority.

A quote side withdrawn by the provider retains its observed zero price and zero size in the source evidence. It
supersedes the prior quote and excludes that candidate until a fresh two-sided quote arrives. It cannot authorize entry,
pricing or liquidation, and a withdrawn required benchmark still blocks the snapshot. Negative, crossed and
contradictory quote sides remain malformed input. Other eligible candidates can continue without a partition-wide
schema rejection caused by the withdrawal. Original capture receipts retain their exact recorded disposition; old
rejection receipts cannot be relabeled as accepted evidence.

Native Jev admission commits the verified source observation, sealed batch plan and every requested candidate claim
in one PostgreSQL transaction before any provider call. Only the successful creator receives dispatch rights. Retries,
including a lost admission acknowledgement, recover existing evidence without another inference. A failed claim insertion
rolls back the new observation and plan. Each response receipt remains independently durable. If admission commits after
expiry, its claims receive undispatched receipts without provider I/O. The existing ten-second inference validity,
quote freshness checks, complete-batch requirement and risk limits are unchanged.

When every candidate already has a committed resolution, finalization verifies the persisted requests, receipts,
resolutions and source observations, then commits the complete result with one idempotent insert. Immutable evidence
does not require another locking transaction. Concurrent finalizers retain the first committed result; pending claims
still use the locked recovery and abandonment path. The result must remain usable at the actual post-commit clock.

Migration 140 retires prior executable Jev authority after terminal mutation cycles, flat inventory, settled orders,
complete accounting and fresh exact reconciliation. It clamps prior PAPER authority for native OBSERVE recovery;
retained generations remain immutable audit evidence. New authority requires the v18 strategy identity.

Migration 136 closed the remaining retired authority write paths at Jev v16. Migration 137 advances that same
research v3 activation contract to Jev v17, while OBSERVE initialization and recovery remain available. It changes constraints
only, without rotating active authority, rewriting retained generations or changing accounting history. Historical
qualified and retired-strategy generations remain readable and can still recover through their existing OBSERVE path.

Crypto benchmarks use verified completed bars and their matching Dorvud feature, with the last completed close as
the benchmark endpoint. BTC uses ETH; ETH and SOL use BTC. A benchmark supplies price context, without a quote
or latest-trade field. Missing required benchmark bars or features reject the entire observation, including when that symbol is also a candidate. Every tradable candidate
still requires its own real window trade, fresh two-sided quote, a valid model-selected setup and protective price choices, and a funded target. A missing ETH print excludes ETH as a candidate without excluding BTC when ETH's completed
bars remain valid. Equity benchmarks retain the existing SPY quote, trade and feature contract.
The immutable query records canonical `benchmarkSymbols`, including symbols that are also candidates. Missing
required benchmark bars or features produce source `not-ready` during snapshot acquisition, before any model request.
Replay verifies those roles again; candidate quote/trade exclusions cannot downgrade a required benchmark failure.
Migration 124 retires protocol v10 for new authority generations and requires flat positions, settled orders, complete
accounting and fresh exact reconciliation before cutover. Its historical observation state was `bayn.jev-trading-signal-state.v10`; current protocol v20 uses state v17.
Entry break-even estimates use native close terms, instrument price rounding and session fee calculation. The common 10 bp adverse limit applies on both sides of LIMIT trading, including fractional equities. Estimated net liquidation includes that sell
allowance, cent-rounded crypto cash fees and equity regulatory fees. Break-even bids reserve one rounding increment
per price-dependent cash fee so a higher bid cannot become a loss at the next fee step. This does not establish
predictive edge or profit.
The equity universe uses the broker exchange calendar. BTC/USD, ETH/USD and SOL/USD use continuous market hours,
including nights, weekends and UTC date boundaries. Both markets share the same account controller, planner, risk
checks, intent coordinator, broker submission adapter, reconciliation and accounting. There is one account budget
and at most one open position. Ordinary entries and application closes use quantity-based LIMIT orders: DAY for equities and IOC for crypto.
Regular-session native equity brackets/OCO disable extended hours; individual crypto protective stops use STOP_LIMIT/GTC.
Crypto uses cash buying power; shorting and margin remain disabled.
Current `bayn.execution-intent.v5` intents store an explicit `limitPriceMicros` and their native protection terms when applicable. That price binds the deterministic
intent identity, immutable SQL row, request, recovery checks and replay checkpoint. Buy spending rounds up to a micro;
sell proceeds round down. Risk caps and turnover use the conservative ceiling on either side. The adapter preserves
the explicit price rather than reconstructing it from rounded notional. Migrations 121 and 122 refuse nonterminal intents,
unfinished bound cycles or unresolved mutations before installing the new write constraints. Decision documents use
`bayn.observe-shadow-decision.v2` and `bayn.paper-cycle-decision.v2`; SQL lifecycle and completion guards require this
same version. Historical rows retain their original bytes and cannot enter the current executable codecs. Accounting
reads retain historical identities and report unsupported execution evidence as unknown rather than inventing prices.
Recovery derives duration from the held instruments and processes one market per pass. There is no MARKET submission path; GTC is restricted to strategy-bound crypto protective stops.
SELL STOP_LIMIT protection uses the same minimum-proceeds floor as SELL LIMIT orders, including fractional inventory
after crypto fees. Conservative order-risk ceilings remain separate from that floor. When a native protection check
observes a flat account, the controller still settles any committed close intents before requesting cycle completion.
Flat inventory cannot bypass durable terminal-intent and accounting completion evidence.
Final instrument admission accepts crypto SELL STOP_LIMIT/GTC only through close-only submission, with positive,
broker-aligned stop and limit prices and a sell limit no higher than its stop. Ordinary LIMIT durations and price
increments remain enforced; held inventory, current authority and account risk checks still apply before transmission.
An unused entry admission expires after one minute. Completed or unused attempts rotate eligible equity and crypto
profiles by their persisted attempt ordinal, so an empty equity session cannot hold the account until its closing bell.
Entry construction checks that original admission lease after inference and again after reconciliation and pricing.
An abstention waits for another observation only while that lease has enough finalization headroom.
Equity session hours cannot extend the unused lease or defer its valid no-trade decision until the closing bell.
A still-current inference batch cannot extend the admission; expiry follows normal waiting and recovery instead of
constructing a decision that the durable contract must reject.
The database retains its row and deferred commit guards when persistence crosses that lease. Only rejection by
the named entry-admission constraint becomes a normal expired-entry result after the transaction rolls back.
Recovery then blocks the still-unused cycle with a fresh timestamp through the existing guarded store; it never
retries the stale decision or retains its partial binding. Other constraint and persistence failures remain errors.
Combined failures, defects and interruption remain intact across the store, writer fence and binding runner; a lease
rejection accompanied by failed rollback cannot become normal expiry or authorize a successor.
Bound decisions, orders and positions retain recovery priority. An expired continuous-market cycle renews only its
three-minute close lease. Fresh reconciled positions can authorize the existing close-only liquidation binding after an outage;
entries retain their original deadline and all account, authority, quantity and order-risk checks still apply.
The generic continuous-cycle close phase starts only when the last admitted entry's fifteen-minute holding
allowance ends, leaving the existing three-minute recovery reserve. The position's own maximum-hold trigger still
starts at its actual first fill. Equity flatten-before-close leads never shorten a continuous position's horizon.
An unused native admission retains its expiry classification at the equity cutoff, including when decision construction
starts before the cutoff but durable binding happens afterward. Recovery still requires the unchanged authority,
evidence and cooldown guards before acquiring a successor.

Current positions require explicit broker cost basis. Migration 115 rejects new cost-less position records;
retained historical observations remain immutable audit evidence. Reconciliation accepts a broker basis derived from
its rounded average price only when both reported price and basis reproduce from the exact native fill cost and
unchanged quantity. Cash, fills, ledger transfers and unrelated basis differences keep their exact checks.
After a partial crypto disposal, reconciliation also reproduces the broker's weighted-average basis from the complete
native entry fills and verified coin-fee accruals. Staggered fills carry the remaining quantity and acquisition average
through every accrual cohort. Each observed broker basis must reproduce from those fill prices,
and every later disposal must reproduce the remaining native quantity and posted cost. The reported average and basis
must match that acquisition calculation exactly. This accounts for per-fill rounding without a monetary tolerance or
changes to immutable ledger amounts. The calculation retains the original fill precision and reproduces rounded
nine-decimal broker averages before rounding the reported remaining cost to micros.

Entry inference uses an explicit transaction-cost break-even exit bid computed for the capital-weighted target,
including the observed spread, up to 10 bp of refreshed quote drift, the existing 10 bp order limit allowance,
coin-denominated buy fees and the existing rounded transaction-fee schedule. Jev selects a complete funded plan with its
`plan_*` action or abstains with `wait` or `avoid`. The extra `net_economics` question and mandatory model-support veto have been
removed: a paired comparison found they suppressed setup entries, and they had not been qualified as a profitable
selection policy. Entry still requires a funded target and every native source, sizing, price and risk check.
These model actions remain uncalibrated and do not establish positive fee-net returns. Partial fills can change realized fees, and operating costs remain unknown. Fresh pricing
above the inference-bound ceiling is rejected before decision construction and again at the durable boundary.
Entry and liquidation pricing may use a quote from just before the completed-minute boundary while it remains
within the exact quote-age limit. Crossing that boundary does not renew the quote or inference lifetime.

Protocol v18 and trading-signal input v16 replace their executable predecessors. Migration 140 requires flat,
settled inventory, terminal mutation cycles, fresh reconciliation and complete accounting before restricting new Jev
authority generations to v18. Create a new same-account PAPER mandate against the verified published v18 image through
its sealed GitOps path after cutover. Historical evidence remains immutable. Retired model exits and fixed-percentage
execution policies cannot authorize current execution. See [strategy protection](../../docs/bayn/strategy-protection.md)
for the rule, supported broker orders, failure behavior and parameter evidence.

A held position that survives an outage can use the same bounded forced-close lease after its data session ends,
while the retained broker calendar still permits extended-hours orders. Whole equity positions retain LIMIT/DAY
execution from fresh exact reconciled broker positions. Recovery does not authorize entries outside entitled data
hours, extend an unresolved order's immutable lease, or submit after the broker session closes.

Current quantities and fill prices use nine-decimal atoms; USD accounting uses six-decimal micros.
Observed bar references, ranges, completed closes and trade signals can carry more than nine decimal places.
Jev rounds these non-executable signal values to micros with decimal half-up rounding while preserving the original values and source hashes in
its observation and model input. Executable bid/ask conversion retains nine-decimal validation and adverse rounding.
Broker equity marks may carry finer decimal precision. Current equity rounds down and previous-close equity rounds
up to micros, including signed values, so the daily-loss comparison is conservative. Cash, buying power, fills and
fee accounting retain their exact precision checks. Original response hashes bind the unrounded provider evidence.
Alpaca response decoding converts compact crypto pair identifiers such as `ETHUSD` to the canonical `ETH/USD`
symbol before positions, assets, orders, fills or fees enter the shared execution path. Internal contracts and
outgoing order requests accept only canonical pair identifiers. Raw response evidence retains its original hash.

Migration 97
requires flat, settled inventory and complete accounting, archives the original projections and preserves existing
ledger identities. It clamps the old PAPER authority to OBSERVE. Activate a newly sealed PAPER mandate against the
published image after the cutover, as described in the [deployment procedure](../../argocd/applications/bayn/README.md).
Retained history is audit evidence; retired protocols and order encodings cannot create or submit current orders.
Crypto settlement records gross fills unchanged and accrues only debits observed in fresh broker positions or cash.
Accruals require the active native cycle, accounted fills, the complete observed order quantity and the corresponding
retained broker snapshot. Fee bounds reject unrelated balance changes. USD cash comparisons use the precision
reported by the provider, while the ledger retains six-decimal micros.
Migration 102 adds immutable settlement accruals, receipt matches and account reporting precision. Cash-yield evidence
uses that retained quantum; historical snapshots without it cannot qualify economic results. Residual sells use their
latest trading date, so directly settled sells from an earlier date cannot block a later close. Preparation commits before ledger posting;
recovery posts the same deterministic plans before accounting later fills. Delayed coin and USD fee activities match
those accruals and post only the remaining adjustment. Activity allocation does not establish individual trade origin:
qualification waits until every accrual for the account, asset and trading date is covered. A partial pooled receipt
cannot finalize another cycle or authority generation. Missing receipts remain incomplete cost evidence, never
zero fees or final economic qualification.
Migration 103 binds each cash accrual to the latest retained account report before its source sell fills and to both
reports' actual precision. It rejects unbound cash-accrual records instead of rewriting financial evidence. Coin
accrual evidence and ledger identities remain unchanged.

Crypto fee receipts retain the provider's `created_at` timestamp in canonical UTC form without rounding. Migration 130 matches
their UTC source date to the existing native accrual cohorts, independently of the activity's posting date. The
timestamp belongs to immutable receipt evidence; the original fee content, posting date, hash, accruals and ledger
plans stay intact. Future timestamps and changed source provenance fail closed. A final receipt settles an existing
debit without charging it again, and every matched quantity remains bounded by both the receipt and its accrual.
This day-level settlement does not establish individual trade origin or economic qualification.

The active model-selected trade-plan contract is documented in [strategy protection](../../docs/bayn/strategy-protection.md).

Failed autonomous cycle passes reach GlitchTip before their durable status projection, including failures the
controller handles without terminating its process. Reports retain typed operation and failure tags while redacting
exception messages and account data. Ordinary broker waits and successful no-trade passes do not create issues;
error-reporting failures cannot replace the pass result. The manual GlitchTip smoke exercises this same boundary.

## Profitability goal

The [October 6, 2026 research review](../../docs/bayn/recent-strategy-research-2026-10-06.md) compares recent candidate papers, their data vintages, execution assumptions, and fit with Bayn. Its shortlist is research context and grants no qualification or capital authority.

Demonstrate repeatable positive net profit after execution, model, and allocated data costs on untouched prospective
sessions. The working target remains the frozen
[`jev-migration-acceptance-v2`](../../docs/bayn/jev-migration-acceptance-v2.json) contract: at least $5,000 net over
20 consecutive registered sessions on the existing $100,000 PAPER allocation, maximum session loss $1,000, and
maximum marked drawdown $2,500. Its paired-control, uncertainty, execution-stress, activity, and evidence requirements
all remain in force. Activity targets never require an otherwise unjustified order.

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

Each command owns that connection through reconnect, its request, and cancellation;
`SET` and its replica `WAIT` stay together. Queued commands retain the one-second
deadline, and interrupting a queued caller does not close an active caller's socket.
Reconnect happens on the next command rather than in a competing background retry.
Replica acknowledgement uses 250 ms waits on the owned connection for the remaining
one-second command budget, without repeating `SET`. Missing acknowledgement at that
deadline cancels the outstanding work and fails publication. A deadline after a
negative acknowledgement retains that replication failure as its cause.

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

Broker capture preserves typed read and session-acquisition failures across its
managed runtime boundary. Poll warnings retain the operation, failure kind,
retryability and HTTP status without logging response payloads. Defects and
interruption are not converted to timeouts or settled as completed work. Every
failed capture disposes its lazy broker runtime before any known-work quota settlement.

`BaynBrokerObservations` is an independent, private, account-keyed Restate Virtual Object. Its exclusive delayed
handlers poll without overlap and publish full and compact snapshots in Valkey before committing their fenced
references in PostgreSQL `broker_observations`. Execution and status processes read those shared materializations; they do not start local pollers. Endpoint registration remains separate
from capital authority. Authorized bootstrap drains a predecessor controller, publishes a fresh observation for the
exact source revision, and only then activates the execution controller. A failed initial sample leaves execution
inactive while the observation object's delayed loop continues to retry.

A polling invocation issues one journaled worker command. Its Restate invocation ID is claimed atomically in
`broker_observation_captures` before any broker HTTP request. The claim survives worker replacement, later polls and
source rotation, so a repeated or late invocation cannot repeat its capture. Publication and failure settle the claim
atomically with their existing database update. Replaying or interrupting an unfinished claim invalidates and fences
only the matching account, source revision and capture generation. A published lost result and a newer cut remain
usable, and interruption retains unknown HTTP quota debt. Trading mutations still invalidate the account-wide
projection. A reserved quota window schedules a
successor without sleeping inside the exclusive polling handler. Deployment activation waits for reserved quota
before capturing the fresh snapshot required to start execution. The same database transaction reserves the account quota before HTTP. Publication or failure replaces that reservation
with measured request debt in PostgreSQL, so losing the Restate result cannot repeat HTTP or discard outstanding quota.
The database generation continues to fence publication after mutations and rotation.

The observation owner's child runtimes share the worker's configured logger and tracer. The polling span inherits
the native Restate attempt's trace, allowing scheduling, capture and publication delays to be inspected together. The
`bayn.broker.observation.poll` span contains capture and publication spans; capture carries its span and log context
across the broker runtime boundary. Existing publication logs are JSON with source revision, snapshot hash, original
observation time, next HTTP-budget deadline and trace/span IDs. The child runtimes create no additional exporter.

The execution controller and broker observation owner preload their small durable state with each invocation.
State reads therefore avoid lazy-fetch round trips before execution or capture. State mutations, capture claims,
quota reservations and replay protection retain their existing durable semantics.

Each poll reads the independent order, fill and fee histories concurrently in both stability scans, retaining complete pagination and the existing before/after stability check,
account and position observations, configuration and recent-order/fill evidence. Original response timestamps and
hashes survive caching. Reconciliation reads one complete cut. Routine account, position and health reads use the same
projection. Each continuous health pass reads and validates one complete projected cut for all six broker components,
rather than fetching and decoding the full history six times. The next pass revalidates a new read; no successful or
failed cut is memoized across passes. Unprojected broker health retains its independent endpoint probes. Final submission reads account, positions and orders from one payload and performs zero broker GETs.
Individual order recovery, filtered historical queries, asset metadata and calendar requests retain direct read access.
There is no refresh-on-miss path for normal submission.

Order history uses descending submission timestamps with an exclusive `until` cursor. A full page retains only
the complete newer timestamp groups and rereads its entire oldest group on the next page, including any siblings
hidden beyond the provider's page boundary. Original timestamp precision and response evidence remain intact.
A full page containing only one timestamp fails closed because timestamp pagination cannot establish its completeness.
The 10,000-order budget, duplicate checks and both stability scans still apply; boundary overlap can add requests.

Stable snapshots collect all currently available fee pages without an activity-creation `until` filter. Alpaca can
exclude an already reported settlement from that filter while its cash effect is visible. Both history scans must
still agree, and pagination budgets, duplicate detection, response hashes and fee date validation remain enforced.

Opening cash and fee baselines read the first retained account snapshot in broker source order. Their queries bind
the event's account and `ACCOUNT` kind explicitly so the existing ordered account-event index can find that snapshot
without scanning historical payloads. Events without a retained snapshot cannot define the baseline.
Observed cash-fee preparation uses that same indexed baseline reader before adding the retained fill and fee cash
deltas. Its regression checks the executed PostgreSQL plans against a populated account history, including foreign
accounts and account events without retained snapshots; this does not change fee bounds or ledger posting order.

Reconciliation owns two writer-fenced transactions. The first recovers previously committed fee plans before
accounting new fills, then ingests the broker cut, retains its cash precision and prepares new fee plans together.
The second posts those newly committed plans, verifies accounting and records reconciliation. Preparation must
commit before its ledger posting; the operation rejects an ambient transaction that would erase this boundary.
Fee preparation rechecks the exact account, amount, time and precision binding without rewriting it. Failed
preparation rolls back the new cut and its precision together; previously committed plans remain recoverable.
Replay cannot change the retained precision or account binding, duplicate inventory debits or bypass writer fencing.

Close preparation waits for exact accounting and resolved broker evidence before constructing a liquidation plan,
including after a fallback obtains a newer cut. Missing settlement evidence keeps the existing position recoverable
with `CLOSE_RECONCILIATION_PENDING`; it does not bind an empty close plan, terminalize the cycle, clear restrictions
or authorize an order. The next exact cut can resume the same bounded close path.

`BAYN_BROKER_POLL_INTERVAL_MS` defaults to 10,000 milliseconds; `BAYN_BROKER_CACHE_MAX_AGE_MS` defaults to 60,000.
Both accept 1,000–60,000 milliseconds and maximum age must exceed the poll interval. The next delayed call accounts
for elapsed polling time using the live transport clock, with a one-second minimum delay. Position closures waiting
for fresh broker evidence resume after one second instead of the normal 30-second controller cadence. Capture is bounded by the smaller of the operation timeout
and maximum age minus the poll interval. Freshness starts at the earlier of the poll start and the oldest original
observation. Expired, premature, corrupt, foreign-account, failed or wrong-revision snapshots fail closed. Restate's
poll epoch/sequence and a database generation prevent duplicate, obsolete or late results from reviving a cut.
If a successful capture races a mutation or newer broker evidence and cannot publish, its successor retries after
one second, subject to the background HTTP budget. A failed capture keeps the regular polling cadence or waits for
the budget deadline, whichever is later. Both paths remain unavailable until a cut passes all publication and
freshness checks.

Jev validates cached account, position, order and reconciliation timestamps against the sixty-second broker
observation ceiling, independently of its ten-second quote limit. A configured shorter cache lifetime still applies
at the projection read, and final risk authorization retains its existing freshness checks.
Maximum-hold, profit-target and protective exits use the same broker ceiling. An expired or future broker observation still
rejects the exit; accepting a cached position does not extend an executable quote's deadline.
A mutation or newer retained broker event can invalidate a successful cut before the next poll. While that cut is
still within the cache lifetime, execution retains `WAITING / BROKER_OBSERVATION_PENDING` and performs no order I/O.
Pending cuts continue after one second, bounded by the configured controller cadence, instead of waiting for the
normal idle interval. The continuation survives worker replacement through the existing durable controller schedule.
The same continuation applies when a terminal close needs a newer exact broker cut, including partial-fill recovery.
Transport failures, inexact accounting and unresolved order or mutation evidence retain the normal retry cadence.
An advanced mutation with no remaining consistency delay still schedules its reconciliation continuation rather than
falling back to the idle interval. Every continuation rechecks existing evidence, quantity and submission deadlines.
Each waiting pass rechecks the projection without broker requests, model calls or order I/O. Expiry, a failed poll,
wrong source revision or corrupt evidence remain failures; waiting cannot make unavailable data usable or clear an
authority restriction.

Known `LOOKBACK_WARMUP` and `SIGNAL_WINDOW_OBSERVED` readiness timestamps can shorten the next durable controller
wait to the next eligible signal boundary. Only a future timestamp before the entry cutoff and earlier than the
existing continuation qualifies. Elapsed, missing or invalid timestamps, other readiness reasons and failed passes
keep their normal cadence. Every wake rechecks source readiness and the existing completed-window admission; it
does not repeat inference on an already consumed window or change broker polling, signal history or position limits.

Position pricing is bounded by the earliest of the first-fill holding deadline, quote-validity budget and
broker-evidence freshness boundary. A completed or retryable result rechecks the holding deadline before returning.
Cancellation waits for scoped finalizers. If finalization outlasts broker freshness, the result requires reconciliation.
The holding-deadline log records any overrun and broker-evidence expiry; order authorization retains all risk checks.

Held-position waits preserve the original deadline and schedule protection checks at most five seconds apart.
An earlier deadline, execution close or existing continuation wins. This absolute next wake survives completion
persistence and worker replay. If work crosses a previously future deadline, one continuation rechecks the position;
an already-overdue evaluation retains the evidence-wait cadence. These bounds schedule evaluation, not guaranteed
broker-flat time. Fresh reconciliation, executable quotes, risk checks and partial-fill recovery remain required.

The send boundary uses a live transport clock rather than a journaled time sample, so a restart before send
persistence cannot add the old remaining delay again. Ordinary polling waits also subtract time already spent on
completion projection and journaling from their persisted due-time budget. An overdue successor is scheduled once
with a one-millisecond minimum; a clock regression cannot extend the original requested delay. Completion logs expose
the requested and scheduled delays plus completion-to-schedule time. Actual delivery still depends on Restate
availability and the next pass repeats the normal execution guards.

Alpaca's Trading/Paper API limit is [200 calls per minute per account](https://alpaca.markets/support/usage-limit-api-calls).
Market-data subscriptions have separate limits. The cache preserves response rate-limit headers. A successful cut
with one order page, two fill pages and one fee page uses fourteen calls, approximately eighty-four calls per minute
at the default cadence. The background client's transport counts every actual attempt, including startup verification,
pagination and transient retries. Each attempt charges at least 600 milliseconds to the next scheduled poll, targeting
100 background calls per minute on average, or half a smaller reported account limit. The three independent history endpoints run concurrently; individual captures can burst. Response headers showing one-quarter or less of account quota
remaining, and HTTP 429 responses, defer further background reads until the later of reset and `Retry-After`; missing
or unusable reset evidence causes a conservative sixty-second wait.

The account's PostgreSQL observation row owns the next permissible poll time. The capture claim and its conservative
unknown-work deadline commit atomically before HTTP. At default timeouts that deadline is three minutes. Completed
captures atomically settle their claim and replace the reservation with measured HTTP debt, including rate-limit
reset evidence. Snapshot invalidation and quota ownership use separate generations, so a mutation racing capture
cannot strand the quota reservation or let an older capture shorten a newer reservation. A failed settlement leaves
the conservative database deadline in force. No process-local budget or Restate result is authority to bypass it.

Ordinary native polls issue one journaled worker command and use eight journal entries rather than thirteen. They
no longer journal separate clock and quota state updates. A quota-blocked poll returns its database deadline and
schedules a successor without holding the exclusive owner. Deployment activation uses a durable timer to wait for
quota before obtaining its required fresh cut. On the first activation of the new revision, the exclusive owner copies
any old Restate quota deadline into PostgreSQL with `GREATEST`, then deletes the old key. There is no second runtime
quota owner or compatibility polling path.

The worker starts its bounded capture clock immediately before the durable claim. A claim that commits after its
start deadline is invalidated without HTTP, and its unused reservation is settled only by the matching database
owner. Clock regression fails closed. Lost, spent and replaced-worker claims cannot repeat HTTP. Failed captures
dispose their broker runtime before recording failure or sampling request debt, so lazy client acquisition cannot
continue issuing requests after recovery returns. Defects and interruption preserve unknown-work debt. Execution
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

Bayn supplies pinned `jev-1.13.0` with verified entry signals, quotes, benchmark relationships and net target economics.
Bayn computes quantities, costs, sizing, risk and exit triggers. The model returns typed entry distributions.

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
verified non-signals. Expired or inconsistent batch evidence retains `INFERENCE_UNAVAILABLE`; requested-candidate
evaluation and all trading, freshness, and accounting checks are unchanged.

Each model request commits its at-most-once claim before inference. Entry batches with exactly one requested candidate persist the receipt, resolution and complete batch result in one
transaction. Entry results retain every excluded candidate in plan order. Entry batches with multiple requested
candidates retain independent receipts and all-candidate finalization. Atomic receipt recording and recovery lock
the batch before the request. A completed batch is verified and reused without opening another transaction. A
failure, defect or interruption during atomic persistence rolls back the receipt, resolution and result together;
the pre-call claim remains pending and cannot trigger another inference. Every consumer still checks the original
evidence deadline after persistence. Synchronous commit and standby durability are unchanged.

The submission window follows the entitled market calendar. Bayn can evaluate after the first completed minute and
the two-second decision delay, at 08:01:02 New York time when the current IEX window opens at 08:00. Crypto evaluates continuously. It uses up to 30 minutes of actual
completed history and evaluates the source-controlled candidate universe against SPY until five minutes before the close. Jev selects complete plans and ranks simultaneous eligible entries by the upward setup probability, for both equities and crypto. Entry spreads may not exceed five basis
points for equities or 25 basis points for crypto. The market profile is part of the strategy identity. It selects at most one long position, capped at 20% of account equity and reduced when
the actual weighted target would exceed order, symbol, exposure or remaining daily turnover limits. The daily counter
includes both buys and sells. Allocation reserves slippage and any current exposure's liquidation notional before
bounding the target; the target weight is applied once. Exposure-reducing closes retain their existing risk exception.
The order cap reserves its full price allowance before sizing because it checks executable notional. Symbol, gross
and net exposure caps retain their reference-price basis. Buy-limit rounding stays inside the reserved allowance.
The reviewed sandbox mandate selects a $1,000,000 daily gross-turnover budget through its exact immutable policy hash.
The sandbox cumulative drawdown cap is $10,000; its daily loss cap stays $5,000. This permits the next PAPER experiment
without resetting historical losses or peak equity. Retained original mandates stay at $200,000 turnover and $5,000
drawdown until explicitly rebound. Live and unspecified environments remain at $200,000 turnover and $5,000 drawdown.
At $100,000 equity and a 20% target, the sandbox budget supports about 25 full-size round trips across the entry
window. This is bounded research capacity, not a profitability assumption. All other sizing, cost and risk checks
are unchanged. The paired research request binds the new strategy and policy hashes; historical requests and
decisions remain immutable. Unknown hashes and the increased hash on live fail closed.
Durable account/session turnover is retained across policy and worker changes, and completed
decisions are not reopened. The image's policy-hash annotation verifies the available increased sandbox policy for its
build-account sentinel; the durable mandate remains the authority for the active account policy.
The runtime writes version-six Jev batches. Valid candidate data reaches Jev without a momentum admission gate.
Jev chooses the entry action and protective prices; supplied price choices and answers bind each exact request.
Only source unavailability, quote freshness, spread and displayed-size checks can exclude a candidate before
inference. A chosen entry without valid model-selected protection cannot create an order. Old batch contracts
remain historical evidence and cannot start current execution. Completed inference and persistence retain the
original ten-second evidence lifetime; fresh execution pricing retains its separate quote-age and price ceiling.
These choices have not established an economic advantage under the frozen qualification protocol.

Entries use capital-weighted quantities at the verified ask, with whole-share equity and native fractional crypto
precision. A single displayed ask size does not cap an order. The existing allocation, buying power, order, exposure
and turnover limits still bound the quantity. LIMIT/IOC prices bound execution cost; a partial fill or cancellation
retains its native recovery and accounting path. The model input states the market spread limit and estimated fees.
The crypto estimate is 25 bps per side, based on observed sandbox fees, and is not an invoice or a guaranteed fee tier.

After selecting a candidate, entry planning reapplies the same spread and positive displayed-size rules to its
refreshed execution quote. A quote that widened or lost either side's displayed liquidity leaves the entry waiting
for fresh evidence before an intent is built. The accepted model evidence remains immutable; quote freshness,
quantity caps and final submission deadlines still apply. This entry check never suppresses a position-reducing exit.

Before selecting a nonempty entry's execution quote, a pass cache cut without the protocol's ten-second quote
headroom is reconciled once. Bayn then checks the original observation times against the existing broker-risk age
limit, current authority and clock again. If the refreshed facts cannot cover that quote lifetime or the model batch
deadline expires, the unbound entry waits for fresh evidence. Changed authority or expired broker facts still require
reconciliation. The model evidence remains immutable, current reconciled facts supply risk inputs, and
final intent, writer-fence and submission-expiry checks still apply. The controller's reconciliation cadence schedules
preflights; it does not expire broker-valid facts during one serialized preparation. The pass rechecks authority on
every reuse and discards its cache before post-mutation continuation. Quote and broker freshness limits are unchanged;
the preparation ordering does not guarantee submission.

Position management binds original accounted entry fills, posted inventory debits, and fresh reconciliation.
Gross entry fills minus posted coin debits and accounted protective disposals must equal held quantity. A missing or unposted debit cannot authorize
management. Overdue positions are evaluated before archive or model work, including crypto positions from a prior
UTC date. Expired broker evidence waits for reconciliation before authorizing a close. The holding deadline is sealed into the selected entry plan and starts at the first actual fill: 15 minutes for
equity and 60 minutes for crypto. The source window remains 30 minutes. The continuous execution window reserves
60 seconds for entry, 60 minutes for holding and three minutes for close recovery; entry validity, loss, drawdown,
exposure, stop, funding, quote freshness and accounting checks are unchanged. A verified adverse bid triggers the absolute strategy stop. A verified bid at the absolute strategy target triggers
the application profit exit when a broker group has not already disposed of inventory. Its initial close must
commit before that quote expires, measured from the quote event time. Native targets bind the proof and deadline;
no model response authorizes an exit.

PostgreSQL checks the initial exit deadline in a deferred constraint at transaction commitment, after evidence reads
and insertion. A late transaction rolls back. Production uses the database wall clock; replay uses its persisted
account clock. This is the server acceptance boundary, not a guarantee about when the commit acknowledgment arrives.
A committed close retains its original trigger through partial fills and recovery after the initial trigger deadline.
New entries and quote-backed instrument-quantized closes use
native LIMIT/DAY equity or LIMIT/IOC crypto orders with a price allowance bounded by the existing risk policy, currently 10 basis points from the
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

Before that session-close window, an unavailable archive does not trigger a redundant reconciliation for a fallback
that cannot yet be used. Eligibility is sampled after the archive attempt, so work that crosses into the window may
use the fallback immediately; the close deadline is checked again after fresh reconciliation. Other before-window
waits continue on the next configured controller pass. Failed close attempts retain the original data reason in logs.
A verified snapshot whose executable quote is stale records `CLOSE_QUOTE_PENDING` and requests a one-second durable
continuation, bounded by the configured cadence and session deadline. Source/bootstrap failures and archive timeouts
retain the normal cadence. Only one serialized controller pass runs at a time; a continuation rechecks all broker,
authority, quantity, and quote-freshness gates. This reduces avoidable idle time but cannot guarantee a fill or a
maximum-hold exit when fresh executable evidence is unavailable.

Entry observations evaluate candidate availability independently. The active Jev protocol binds
`bayn.candidate-evidence.quote-window-trade.v1`. A candidate needs a quote no older than 10 seconds, a real trade
at or after the context start and available by observation, and at least one real finalized minute bar with a matching
observed-price feature. The latest completed minute must be present; older missing minutes remain explicit gaps.
The quote may precede the completed bar boundary. Neither a post-range trade nor a trade within the quote-age limit
is required. Jev receives the trade's actual age as context, not as an executable price. Quote and trade ingestion
delays still obey the feed bound. Missing current input or a stale quote excludes that candidate. Real historical backfills are usable after their
actual arrival and never supply a current executable quote.
SPY retains the mandatory benchmark evidence contract. Source identity, canonical ordering, watermarks, finality,
and premature data still fail the whole observation. Raw candidate rows, exclusions, and all observed matching
feature receipts remain in the hashed snapshot, including features for rejected candidates.

Missing historical minutes are reported with their timestamps and do not impose another warmup. A missing latest
completed minute or matching observed feature still blocks that symbol. The IEX feed can omit a minute when its
trades do not qualify for a bar; see Alpaca's [minute-bar rules](https://alpaca.markets/learn/stock-minute-bars). Bayn
never creates substitute bars. Return horizons without their actual reference bar and incomplete volume comparisons
remain unknown. Candidate and benchmark momentum use the earliest actual minute present in both histories.
The active runtime accepts only the current observed-history contracts; retired snapshots are not converted.

Native Jev targets retain every candidate result and exclusion with the exact full-batch evidence. Source exclusions
alone cannot authorize a no-entry decision. A version-two or version-three entry batch with every candidate excluded by
a verified spread or displayed-size rule can. Execution pricing requires fresh quotes for positive targets and
reconciled holdings.
Historical momentum targets remain readable for audit.

Entry observations commit at most once per completed signal window within a cycle. Later polls and restarts
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
admission returns typed expiry and observation evaluation waits with `INFERENCE_UNAVAILABLE`. It creates no plan,
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

The cycle store retains at most one fully validated decision's canonical wire JSON, up to eight MiB, after binding
or a cold durable read. Every reread still queries PostgreSQL and requires full JSONB equality with that retained
body. A match returns fresh completion and generation evidence without returning or decoding the full document body;
changed documents return the complete body and take complete validation. Returned documents are detached, and
completion, supersession, current authority, pricing and expiry checks remain fresh. A retained decoding result does
not prove that its binding committed and cannot create a missing database row. The `bayn.cycle.decision-read` stage
records retained wire bytes, match and body row counts, and elapsed read time without recording document contents.

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
- The `effect@4.0.0` package patch exposes its SQL transaction semaphore. The writer fence supplies that semaphore
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
- Jev HTTP spans retain Effect's default redaction for authorization, cookies, Set-Cookie and API-key headers while
  preserving HTTP status, timing and rate-limit diagnostics. The inference client preserves caller-provided redaction.
- Rejected positions responses emit one bounded schema diagnostic on the existing read span and a warning. The
  `broker.decode_field` path uses only authored position fields and `[]` in place of array indices; issue, expected type
  and actual type use fixed categories. Payload values, arbitrary keys, schema messages and account identifiers are
  omitted. The response remains `INVALID_RESPONSE`; unsupported issue shapes report `unknown` rather than formatting
  the error. Successful reads, other endpoints, deadlines, retries, validation and freshness are unchanged.
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
  keeps its own request and retry deadlines. Both broker-history captures remain mandatory for every snapshot poll.
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
  Fees first observed or posted after the selected reconciliation retain their economic-date attribution and
  amounts, but leave the report `INSUFFICIENT_EVIDENCE` with `UNCLOSED_WINDOW`. A closed reconciliation cut cannot
  certify later fee evidence, including a delayed posting of an earlier observation.

- The public Bayn deployment serves read-only status and health. It does not schedule execution or hold mutation
  authority. Its Kubernetes readiness checks fresh PostgreSQL, ledger and cycle-projection reads. Broker reconciliation
  and the bound execution controller retain their own operational readiness in `/readyz` and `/v1/status`.
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

Alpaca WebSocket events enter the existing raw Kafka topics. Each execution worker owns a complete
`@platformatic/kafka` projection for the 16-symbol core universe. Dorvud/Flink independently publishes rolling
features to `torghut.market-features.v1`; the archive retains raw and feature messages in ClickHouse. The strategy
evaluates the fifteen non-SPY symbols, with SPY supplying the benchmark. The public status service does not consume Kafka.

The projection yields to the Node event loop every 256 consumed records, including records discarded after an
assignment is revoked. Buffered history cannot monopolize the worker while broker I/O, deadlines, and scope
cancellation wait. Incorporation order and committed offsets retain the same rules.

The worker joins a completed feature window to its exact raw bar revisions, a fresh executable quote, and the
trade evidence required by the bound candidate policy.
Corrections invalidate an old feature until its replacement matches. Missing candidates produce exclusions;
missing benchmark data or absence of every candidate makes the observation unavailable. Streaming failures never
silently switch to the archive path. Reconciliation and the existing close-window recovery remain available.

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

The forward-performance command emits `bayn.forward-performance-report.v5`. Its hashed `scope` records the requested
`AUTHORITY_GENERATION` and `authorityGenerationHash`, including when no eligible financial cycle exists. Programmatic
account-history reports declare `ACCOUNT` scope. Requested scope does not supply missing financial source or strategy
bindings; those remain null until eligible evidence exists. Its `inferenceExpenses` section joins
all claimed requests, including no-trade cycles, to frozen quotes and verifies the complete account/session set in
TigerBeetle ledger 7002 before attributing estimates to the requested authority generation. Amounts retain USD_PICO
precision. Missing quotes, usage gaps and unverified acknowledgements remain explicit. The stored v4 trading receipt
is unchanged. `operatingCostCoverage` remains `INCOMPLETE` until invoice and other operating-cost evidence exists;
tariff estimates cannot establish fully costed profitability.

### Private inference operating-cost report

The forward-performance ledger reader verifies trading transfers and broker fees. It has no operating-expense
coverage: `otherChargedCostsMicros`, `netRealizedPnlAfterCostsMicros`, and `netRealizedReturn` remain null, with
`OPERATING_COST_EVIDENCE_GAP` and profitability `UNDETERMINED`. Independently known cost-coverage, missing-ledger and
unsettled-fee gaps remain explicit when starting capital is unavailable; unavailable financial totals remain null.
Verified gross trading P&L and fees remain visible when the required financial boundary exists.
Exact trading reconciliation does not prove inference, data, infrastructure, or research expenses are zero.
Complete implementation shortfall also remains unresolved without explicit cost evidence. Existing immutable
receipts keep their original bytes and hashes; this correction applies to newly computed reports.
Tariffs and expense packets are configured on the private command below. Their account/session scope is not
silently applied to a generation or window report.

Inference expenses are distinct from broker cash and execution fees. The read-only operator command reads claimed
Jev requests across all cycles for one account and exchange-session date, including blocked and no-trade cycles:

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
filter execute in a repeatable-read, read-only transaction. More than 10,000 claimed requests fails explicitly rather
than returning a partial session. Keep evidence, rate cards, and report outputs private; they are not public status
endpoints, source fixtures, or CI artifacts. `node dist/inference-cost-command.js` is the corresponding compiled entry.

The native execution server also owns an independent inference-expense projection. Every 30 seconds it reads at
most 64 resolved requests for its bound account, freezes the original request/receipt/resolution hashes and tariff
in `inference_expense_quotes`, and posts deterministic transfers to TigerBeetle ledger **7002**. That ledger's unit is
**USD_PICO**: one USD is 1,000,000,000,000 units, so a single input token at the current Jev list price records 42,000
units without rounding each call. Session accounts debit estimated inference expense (code 510) and credit
estimate clearing (code 230). The trading ledger and broker cash balances retain their existing units and purpose.

This projection starts with sessions on 2026-10-05 and the reviewed, frozen Jev 1.13.0 list-price assumption:
$0.042 per million input tokens and zero output charge, verified at `https://docs.typesafe.ai/models` on
2026-10-07 UTC. Its tariff interval identifies where Bayn applies that assumption; it is not evidence that the
provider has guaranteed future prices. Later reviewed tariff changes apply to new quotes. Existing quotes cannot
be repriced or deleted. A transfer ID binds the account and request independently of tariff revisions. A lost
TigerBeetle or PostgreSQL acknowledgement replays the same record and verifies all metadata before completing.
`verified_at` means the frozen quote was checked against its expected ledger records, not against an invoice.
Retained rejected or abandoned responses with valid usage are included. Missing usage and unpriced models remain
explicit quote gaps; they produce no fabricated zero charge. An immutable late receipt can add a priced quote to
an abandoned gap without posting the request twice. Earlier sessions remain outside this projection's coverage.

The projection owns separate scoped PostgreSQL and TigerBeetle clients. Closing positions never waits for it.
Both execution replicas may safely recover the same pending quotes. To inspect a complete private session cut:

Expense reports capture requests and frozen quotes in one PostgreSQL statement, including inside the execution
writer transaction. The reader pins a native TigerBeetle timestamp and verifies every session transfer and the
history-enabled account balances at that cut. A subsequent quote read identifies legitimate charges committed
while the report runs; unknown transfers and mismatched balances still fail. Only the original captured quotes
contribute to the report subtotal. Trading and expense posting continue throughout the read.

The ledger report uses `bayn.inference-expense-ledger-report.v2`. `sourceAsOf` identifies the PostgreSQL capture;
`ledgerTimestampMax`, `verifiedSessionTransferCount` and `exactLedgerPrefix` identify the verified native prefix. `transferCount` and
`knownEstimatedCostPicoUsd` describe the captured quote set. Forward reports retain both cut witnesses. These
timestamps belong to different systems and are never compared to infer ordering. Pending quotes remain explicitly
unverified, and verification does not establish invoice reconciliation.

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
validated pinned-model and input/output usage fields. The failed receipt's response hash binds that exact metering
projection, not the complete HTTP error body. Error text, echoed prompts, credentials and arbitrary fields are not
retained. Missing, malformed, oversized or interrupted bodies remain unknown; status failures never authorize a
decision or trigger an inference retry. Previously saved receipts and their missing usage remain unchanged.

The report verifies immutable request, receipt, rejected-response, and resolution hashes. A rejected or abandoned
decision can still carry billable usage. A claim without retained usage stays unknown: it does not prove either that
the provider received a request or that no charge occurred. Identical repeated evidence is deduplicated by request
identity; conflicting duplicates fail. Token counts are safe integers. Cost arithmetic retains pico-USD precision
and rounds the aggregate upward to micro-USD only once. These are metered estimates, not invoice-reconciled costs.

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

This migration retires the previous decision and market-data contracts. Before promotion, verify that no unfinished
cycle references a retired decision or snapshot and that broker orders, positions, and ledger balances reconcile.
If an earlier release still owns such work, let that release finish recovery before the cutover. Retain terminal
financial documents unchanged for audit; do not rewrite their hashes or restore legacy runtime decoders.

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
Persistence is append-only and idempotent for unchanged evidence; the creation timestamp comes from the fixed
evidence cut, not invocation time. A conflicting receipt for the same authority generation fails closed.

The command always requires `--authority-generation`; omitting `--persist-receipt` keeps that same generation scope
read-only. Programmatic account-history reports may span retired strategies and mandates and declare `ACCOUNT` scope.
Account history that includes legacy daily SIP evidence requires the historical settings described above; native-only
history does not. A scope without completed executions remains unqualified.
The command emits `bayn.forward-performance-report.v5`. Its `receipt` contains the v4 financial receipt with explicit broker cash settlement rounding;
`positionEpisodes` measures completed entry-to-flat episodes separately from fill transactions. `inferenceExpenses`
attributes ledger-verified session estimates to the requested generation, and `operatingCostCoverage` remains
`INCOMPLETE` while other operating charges are unknown. `reportHash` binds the requested scope and all report content. The report does not
change the immutable per-generation receipt schema.
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

The PostgreSQL cluster reserves 512 MiB of shared buffers and 16 MiB of WAL buffers within its 2 GiB memory limit.
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
control-study input v7 with deterministic entry and artifact v2. It compares the seven-feature score with the genuine training-only
day-weighted target mean under the same fixed-principal budget and mechanical execution rules. Native
First-completed-minute eligibility is unchanged. It uses original-capture six-bar observations and the
existing serial portfolio; missing inputs remain incomplete even when the baseline would choose cash. It grants
no production registration, qualification or capital authority.

### Bounded mechanical control and turnover comparison

The sole development contract is `bayn.control-study-input.v7`, with explicit `entry`, `management` and
`turnoverPolicy`. It retains the deterministic controls, optional frozen residual-shock candidate and Ridge pair.
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

The input is `bayn.backtest.v5` in `src/intraday-replay/backtest.ts`. It binds an explicit UTC `interval` with `startAt` and `endAt`, the full broker calendar,
source manifest, native Jev build and strategy identities, opening cash, asset metadata, execution assumptions,
controller cadence, and cost assumptions. Retired momentum backtest inputs cannot start the native runtime.
Historical artifacts remain available for comparison and audit.

Set `BAYN_JEV_API_KEY` and `BAYN_PUBLIC_INFORMATION_PROXY` through the existing protected environment. The command requires an
`inference` object with `mode: "measured-provider"`, `model: "jev-1.13.0"`, and
`inputDefinition: "bayn.jev-trading-signal-state.v17"`, and positive `maximumCalls`. The input
binds `jevInstructionsHash` to the exact compiled instruction document. `bayn-backtest --instructions` reports it.
Its `costs` object contains
`inputMicrosPerMillionTokens` and `outputMicrosPerMillionTokens` as integer strings. The input also declares
`allocatedDataCostPerSessionMicros`, either a priced integer-string allocation or explicit `null` when unknown.
An unknown allocation preserves execution evidence while making sessions and net results incomplete; it never
becomes a zero expense. Control comparisons and net-label training require a priced allocation. Changing these
assumptions changes the run identity.

The provider uses an independent live clock. Replay retains original provider requests, responses and timestamps
in `jev-calls.ndjson` before advancing market and database time. Concurrent calls share elapsed time. Native
PostgreSQL batch and evaluation stores retain the mapped evidence and enforce the original inference deadline.
Failed or interrupted calls with unresolved charges make the cost result incomplete. Known charges use the declared
tariff with each call rounded upward to one micro-dollar. Invoice verification remains required for qualification.

Native replay uses the same Jev CONNECT-proxy adapter as production. Its provider-call ceiling counts dispatch
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
The final `bayn.backtest-report.v4`
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
bun run --filter @proompteng/bayn lint:oxlint
bun run --filter @proompteng/bayn build
```

CI partitions the complete unit suite into four duration-balanced Bun shards with two isolated workers per shard.
The CI default test budget is 15 seconds for full research fixtures on shared runners; explicit test budgets still apply.
Effect compatibility and broker sandbox tests run in this suite with broker credentials removed. PostgreSQL uses
four sequential shards, each with its own disposable database; `bun run --filter @proompteng/bayn test:postgres 1/4`
runs one shard locally. Omitting the shard runs the complete PostgreSQL suite. Never run concurrent shards against
the same database. ClickHouse/Java archive checks and PostgreSQL/TigerBeetle ledger checks run in separate jobs.
The release gate requires every shard and integration job to pass.

With `BAYN_TEST_POSTGRES_URL` pointing to a disposable `bayn_test` database and
`BAYN_TEST_TIGERBEETLE_ADDRESS` pointing to an isolated TigerBeetle instance, run
`bun run --filter @proompteng/bayn test:ledger`. CI uses the same command. It covers native Jev entry,
zero and partial fills, DAY cancellation and cycle completion, process death/restart, accounting and inference
expenses. The seven durable-broker cases alone do not cover the native production lifecycle.

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

The [GEPA optimizer](../../docs/bayn/jev-optimization.md) proposes the same actual-entry complete-plan instruction
consumed by native Jev. It uses one pinned GEPA engine and explicit native financial outcomes. The former Harness2
runner and active factor/editor contracts are removed. Jev remains the typed System One model. The selected shared Flamingo or native OpenCode free endpoint only edits
the question document through the signed research workflow. The isolated CPU gateway `opencode-research` in
namespace `opencode` retains one session per study,
with one hosted call per proposal and no paid fallback. Its actual provider input, raw response and source/configuration
identity travel in the verified research receipt, with separate gateway and worker source revisions.
See the runbook for native session and budget enforcement and the [standalone server](../opencode/README.md)
for development access and the verified state migration.

The published image supplies `bayn-gepa`, `bayn-gepa-native`, `bayn-jev-evaluate` and `bayn-control-study`.
Research variants change one validated data module and retain exact source, dependency, request/response, cost and
execution evidence. The runner reserves paid calls before dispatch, rejects ambiguous retries, keeps evaluation
feedback out of proposals and retains an unchanged-question repeat. Existing numerical controls provide a separate
common mechanical-exit comparison. Unknown costs remain explicit; all outputs are unqualified and grant no capital authority.
Use the runbook for existing-data manifests, isolated local accounting targets, compiler source mounts and receipts.

### Independent public information jobs

`BaynPublicInformation` runs one private Restate Virtual Object per `SEC_FILINGS` and `MACRO_CALENDAR` source on the
existing research endpoint. Activation schedules work and returns without fetching. Each exclusive poll journals one
bounded collection command and a delayed successor. Revision and sequence guards fence superseded or duplicate
polls. HMAC activation proofs use a separate purpose string with the existing research approval key; the key is never
sent to Restate. The research worker submits these activations asynchronously after listening. Before each submission,
it checks the control endpoint's deployed source revision through ingress and retries until it matches. This prevents
an accepted send from binding a new activation to an old deployment while the operator is registering the new endpoint.
Each source submits and retries independently, so a failed filing activation cannot prevent macro scheduling.

The filings job checks SEC ticker mappings, submissions and XBRL company facts every fifteen minutes. The macro job
checks the BLS iCalendar and Federal Reserve FOMC calendar hourly. Requests use fixed official URLs, a dedicated public
HTTP client, at least one second between requests, a sixteen-MiB body bound, a thirty-second capture deadline and a
ten-minute run bound. Redirects are rejected. Broker, model and object-store credentials and trace propagation headers
are absent from public requests. A missing ticker mapping or a company-facts 404 is an explicit exclusion.

Original UTF-8 source bytes are written under `captures/v1/public-information/` in the existing private Rook research
bucket. Before the first collection under each code revision, the job requires an owner-only private ACL and exact synthetic
upload/readback verification. The generated `BUCKET_NAME` selects the bucket. The research worker uses its reflected OBC owner credential;
no trading process receives it. Restate retains small artifact references, SHA-256, byte length, actual fetch/upload/check
clocks, source revision, exclusions and failed URLs. It never journals the source documents. Unchanged content reuses its
original artifact and fetch clock while advancing its successful check clock. A failed refresh retains the last good
reference and its original timestamps within the current issuer universe. Retained symbol-to-CIK mappings keep a
failed ticker refresh explicit while pruning references for removed issuers. These inputs support research; they do
not change active entry or exit policy.

The SEC artifacts are filing-history metadata and XBRL financial-fact JSON, not the full text of every filing. BLS and
Federal Reserve artifacts retain the original calendar file and HTML. Changed content gets a new immutable object key;
this rollout adds no automatic expiry or deletion of historical source snapshots.

Collection runs in a separate research process with independent HTTP and storage resources. Execution, protective
closures, native execution activation and trading readiness neither invoke nor await these jobs. Source, parsing,
upload, configuration and activation failures stay with the public job. Each failed poll retains its next scheduled
attempt. Source-labelled duration, completed/incomplete polls, bytes, document counts, last-success metrics and traced
fetch/upload spans support session diagnosis. The stale-input alert is a research warning and does not stop trading.

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
predicate with the shared strict DAY/IOC proof, including the renamed partial-fill helper. Migration 144 owns the
market-specific holding-horizon v21 cutover. Verify flat settled inventory, terminal orders, complete accounting and
fresh exact reconciliation before activating a new same-account v21 PAPER mandate against its verified published
image. Existing evidence, loss history, capital limits and acceptance cohorts remain intact.
Operator restrictions and immutable financial evidence remain enforced throughout OBSERVE recovery.
See the [Alpaca hours investigation](../../docs/bayn/alpaca-equity-hours-2026-10-16.md) for feed entitlements and
current execution limits. This migration grants no live capital authority.
