# Bayn

Bayn is a single-writer intraday execution service. Restate schedules one account-keyed controller, pure TypeScript
decides what should happen, Effect interprets one bounded pass, PostgreSQL stores trading truth, TigerBeetle stores
accounting truth, and the broker adapter performs account-environment-neutral execution.

The source selects one active strategy, `jev`, using momentum-first `bayn.jev.protocol.v2`. Historical strategy
rows remain decodable for audit and reconciliation, but they are not runtime fallbacks and cannot create new cycles.

The [momentum-first research policy](../../docs/bayn/momentum-first-candidate.md) uses a protocol-v2 entry gate:
exact positive own and SPY-relative momentum before Jev, with current Jev selection, sizing and management preserved.
The paired sandbox mandate binds this policy and its $1,000,000 daily turnover budget; source selection alone grants no capital authority.

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

## Broker observation owner

`BaynBrokerObservations` is an independent, private, account-keyed Restate Virtual Object. Its exclusive delayed
handlers poll without overlap and publish a complete snapshot in PostgreSQL `broker_observations`. Execution and
status processes read that shared projection; they do not start local pollers. Endpoint registration remains separate
from capital authority. Authorized bootstrap drains a predecessor controller, publishes a fresh observation for the
exact source revision, and only then activates the execution controller. A failed initial sample leaves execution
inactive while the observation object's delayed loop continues to retry.

The observation owner's child runtimes share the worker's configured logger and tracer. The
`bayn.broker.observation.poll` span contains capture and publication spans; capture carries its span and log context
across the broker runtime boundary. Existing publication logs are JSON with source revision, snapshot hash, original
observation time, next HTTP-budget deadline and trace/span IDs. The child runtimes create no additional exporter.

Each poll reads the independent order, fill and fee histories concurrently in both stability scans, retaining complete pagination and the existing before/after stability check,
account and position observations, configuration and recent-order/fill evidence. Original response timestamps and
hashes survive caching. Reconciliation reads one complete cut. Routine account, position and health reads use the same
projection. Final submission reads account, positions and orders from one payload and performs zero broker GETs.
Individual order recovery, filtered historical queries, asset metadata and calendar requests retain direct read access.
There is no refresh-on-miss path for normal submission.

Opening cash and fee baselines read the first retained account snapshot in broker source order. Their queries bind
the event's account and `ACCOUNT` kind explicitly so the existing ordered account-event index can find that snapshot
without scanning historical payloads. Events without a retained snapshot cannot define the baseline.

`BAYN_BROKER_POLL_INTERVAL_MS` defaults to 10,000 milliseconds; `BAYN_BROKER_CACHE_MAX_AGE_MS` defaults to 60,000.
Both accept 1,000–60,000 milliseconds and maximum age must exceed the poll interval. The next delayed call accounts
for elapsed polling time, with a one-second minimum delay. Capture is bounded by the smaller of the operation timeout
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
Maximum-hold, model and protective exits use the same broker ceiling. An expired or future broker observation still
rejects the exit; accepting a cached position does not extend a model response or executable quote's deadline.
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

Discretionary management is bounded by the earliest of the first-fill holding deadline, inference-validity budget,
and broker-evidence freshness boundary. A completed or retryable management result rechecks the holding deadline
before returning. Cancellation still waits for scoped finalizers. If finalization outlasts broker freshness, the
result requires reconciliation instead of constructing an exit from stale evidence. The holding-deadline log records
any overrun and the broker-evidence expiry; order authorization retains all existing risk checks.

Held-position waits also retain the first-fill-based maximum-hold deadline. A future deadline caps the next wake,
while an earlier signal boundary still wins. The absolute bound survives management work, completion persistence,
and worker replay. If work crosses a deadline that was future when management checked it, one continuation rechecks
the position; an already-overdue evaluation retains the normal evidence-wait cadence. This schedules exit evaluation,
not a guaranteed broker-flat time: fresh reconciliation, executable quotes, risk checks and partial-fill recovery
remain required. Old retained completions keep their existing durable replay command order.
The send boundary uses a live transport clock rather than a journaled time sample, so a restart before send
persistence cannot add the old remaining delay again. An overdue successor is scheduled once with a one-millisecond
minimum; actual delivery still depends on Restate availability and the next pass repeats the normal execution guards.

Alpaca's Trading/Paper API limit is [200 calls per minute per account](https://alpaca.markets/support/usage-limit-api-calls).
Market-data subscriptions have separate limits. The cache preserves response rate-limit headers. A successful cut
with one order page, two fill pages and one fee page uses fourteen calls, approximately eighty-four calls per minute
at the default cadence. The background client's transport counts every actual attempt, including startup verification,
pagination and transient retries. Each attempt charges at least 600 milliseconds to the next scheduled poll, targeting
100 background calls per minute on average, or half a smaller reported account limit. The three independent history endpoints run concurrently; individual captures can burst. Response headers showing one-quarter or less of account quota
remaining, and HTTP 429 responses, defer further background reads until the later of reset and `Retry-After`; missing
or unusable reset evidence causes a conservative sixty-second wait. The budget survives background client replacement, and Restate
journals and retains the next permissible poll time in durable account state for successful, invalidated and failed
captures, so worker replacement and source rotation preserve outstanding cost. Larger captures extend the
poll cadence rather than adding artificial delays inside a full history scan. Before each capture, including repeated
activation, Restate journals the budget deadline and waits with a durable timer before starting the bounded capture
and its database ticket. It also journals a single-use worker ticket and reserves one quota window beyond the latest
allowed capture start and invocation abort bound before issuing requests. A lost or spent ticket, or one whose start
deadline elapsed, returns unavailable without repeating broker I/O. When the same worker atomically consumes a
matching unused expired ticket, successful invalidation and the existing journaled poll result prove that capture
never started. Only then can the owner replace speculative debt with the existing measured HTTP/quota deadline;
it logs the reason and capture-start lateness without ticket contents. A lost result before journaling still retains
the full reservation. A journaled result replays without another claim or a reset capture clock.
A completed capture replaces the reservation with
its measured request cost; interruption or an unreturned result retains the conservative reservation. With default
timeouts that reservation is three minutes, while completed ordinary captures retain the ten-second target.
Completed, typed persistence failures inside a claimed worker also retain the measured request cost, including any
quota-reset deadline. They return unavailable without publishing a snapshot and retry on the ordinary polling cadence.
Failed captures dispose their broker runtime before recording failure or sampling the settled request budget, so a lazy
client acquisition cannot continue issuing requests after recovery returns. Defects, interruption, mixed failure causes,
and missing, mismatched, already claimed or replaced-worker capture tickets retain the conservative reservation.
Failure or interruption before the unused-ticket result is journaled also retains that reservation.
Long quota waits suspend the invocation without using its inactivity timeout. Interruption during
the wait preserves the outstanding budget. Existing capture deadlines and cache expiry still apply; an incomplete
capture cannot publish. Execution requests use their existing client and consume the remaining shared account quota;
the background budget does not impose a global limit on other account callers.

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

Bayn supplies TypeSafe's pinned `jev-1.13.0` System One model with verified prices, volume, computed technical
indicators, quotes, benchmark relationships and actual position context. Bayn computes quantities, cost basis,
holding time, returns, sizing and risk. The model returns typed probability distributions for entry or management.

The [TypeSafe SDK response contract](https://docs.typesafe.ai/sdk/python/api/types/responses#typesafe_sdk.ChoiceAnswer)
describes approximately normalized probabilities. Bayn requires a normalized distribution to fit within 0.005 of
each reported probability, so the total allowance scales with the number of choices. These are Bayn validation bounds, not a
provider precision guarantee. Score answers must also fit the same distribution bounds and a 0.005 score allowance.
Bayn retains the reported values and hashes without normalization. Selection uses reported probabilities; larger
discrepancies, mismatched choices or inconsistent scores remain unusable evidence.

Each model request commits its at-most-once claim before inference. Native single-candidate management and entry
batches with exactly one requested candidate persist the receipt, resolution and complete batch result in one
transaction. Entry results retain every excluded candidate in plan order. Entry batches with multiple requested
candidates retain independent receipts and all-candidate finalization. Atomic receipt recording and recovery lock
the batch before the request. A completed batch is verified and reused without opening another transaction. A
failure, defect or interruption during atomic persistence rolls back the receipt, resolution and result together;
the pre-call claim remains pending and cannot trigger another inference. Every consumer still checks the original
evidence deadline after persistence. Synchronous commit and standby durability are unchanged.

The submission window opens with the regular session. Bayn waits for its first fully elapsed 30-minute IEX window and
the two-second decision delay. It evaluates the source-controlled candidate universe against SPY until five minutes
before the close. The default development protocol requires an entry probability of at least 0.65 and a spread no
wider than five basis points. It selects at most one long position, capped at 20% of account equity and reduced when
the actual weighted target would exceed order, symbol, exposure or remaining daily turnover limits. The daily counter
includes both buys and sells. Allocation reserves slippage and any current exposure's liquidation notional before
bounding the target; the target weight is applied once. Exposure-reducing closes retain their existing risk exception.
The order cap reserves its full price allowance before sizing because it checks executable notional. Symbol, gross
and net exposure caps retain their reference-price basis. Buy-limit rounding stays inside the reserved allowance.
The reviewed sandbox mandate selects a $1,000,000 daily gross-turnover budget through its exact immutable policy hash.
Retained sandbox mandates stay at $200,000 until explicitly rebound. Live and unspecified environments remain at $200,000.
At $100,000 equity and a 20% target, the sandbox budget supports about 25 full-size round trips across the entry
window. This is bounded research capacity, not a profitability assumption. All other sizing, cost and risk checks
are unchanged. The paired research request binds the new strategy and policy hashes; historical requests and
decisions remain immutable. Unknown hashes and the increased hash on live fail closed.
Durable account/session turnover is retained across policy and worker changes, and completed
decisions are not reopened. The image's policy-hash annotation verifies the available increased sandbox policy for its
build-account sentinel; the durable mandate remains the authority for the active account policy.
The runtime writes version-four Jev batches. Exact positive own and SPY-relative momentum gates precede Jev;
Jev retains its probability-ranked accept/wait/avoid decision among eligible signals. Verified non-signals,
wide-spread or zero-displayed-size entry quotes become explicit
exclusions without a Jev call. An entry batch where every candidate is excluded for a verified momentum or entry-quote reason can
yield a no-entry decision; missing source evidence cannot. Retained version-one through version-three batches keep their
original identity and quote-deadline binding. Position management still evaluates its held symbol. A complete
version-four batch must finish within its ten-second evidence lifetime. After the batch is accepted, entry risk uses
the fresh execution quote's event time and ten-second maximum age; the earlier batch deadline does not shorten that
quote deadline for version-three or version-four decisions. These parameters have not established an economic advantage under the
frozen qualification protocol.

After selecting a candidate, entry planning reapplies the same spread and positive displayed-size rules to its
refreshed execution quote. A quote that widened or lost either side's displayed liquidity leaves the entry waiting
for fresh evidence before an intent is built. The accepted model evidence remains immutable; quote freshness,
quantity caps and final submission deadlines still apply. This entry check never suppresses a position-reducing exit.

Before selecting a nonempty entry's execution quote, a pass cache cut without the protocol's ten-second quote
headroom is reconciled once. Bayn then checks the original observation times against the existing broker-risk age
limit, current authority and clock again. If the refreshed facts cannot cover that quote lifetime or the model batch
deadline expires, the unbound entry waits for fresh evidence. Short reconciliation cadences remain supported and may
still require a later refresh. The model evidence remains immutable, current reconciled facts supply risk inputs, and
final intent, writer-fence and submission-expiry checks still apply. Ordinary reconciliation reads and quote or broker
freshness limits are unchanged; the preparation ordering does not guarantee submission.

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
at or after the lookback start and available by observation, and 30 consecutive minute bars with their matching rolling feature.
The quote may precede the completed bar boundary. Neither a post-range trade nor a trade within the quote-age limit
is required. Jev receives the trade's actual age as context, not as an executable price. Quote and trade ingestion
delays still obey the feed bound. Missing input, a stale quote, or late input excludes that candidate.
SPY retains the mandatory benchmark evidence contract. Source identity, canonical ordering, watermarks, finality,
and premature data still fail the whole observation. Raw candidate rows, exclusions, and all observed matching
feature receipts remain in the hashed snapshot, including features for rejected candidates.

Missing minute bars are reported with their timestamps. A complete raw window without a matching observed feature
has a separate reason. The IEX feed can omit a minute when its trades do not qualify for a bar; see Alpaca's
[minute-bar rules](https://alpaca.markets/learn/stock-minute-bars). Bayn neither creates substitute bars nor combines
30 nonconsecutive bars into a 30-minute feature. Stored observations without the new evidence policy reproduce
their original contract. The active runtime selects the new policy explicitly.

Native Jev targets retain every candidate result and exclusion with the exact full-batch evidence. Source exclusions
alone cannot authorize a no-entry decision. A version-two or version-three entry batch with every candidate excluded by
a verified spread or displayed-size rule can. Execution pricing requires fresh quotes for positive targets and
reconciled holdings.
Historical momentum targets remain readable for audit.

Entry and position-management observations each commit at most once per completed signal window within a cycle.
Later polls and process restarts consult the retained observation before creating another inference batch. The next
evaluation requires the next completed minute and its decision delay. An interrupted or failed observation does not
authorize another inference attempt on the same window. Entry recovers pending batches and checks the retained window
before loading full signal history, so a consumed window can wait without rebuilding an unusable snapshot. New entry
windows still require verified source evidence before observation or inference. Protective stops and the holding limit
remain eligible on every management pass. Position management checks those protections first, then recovers pending
batches and checks the retained observation window before loading full signal history. A consumed window therefore does not rebuild its
signal snapshot; protective quote reads remain fresh on every eligible pass. A newly admitted window still requires
the matching, verified signal snapshot, and source or durable-store failures cannot authorize an inference attempt.

A newly committed terminal Jev cycle makes one best-effort attempt to seal its own expired pending batches, across
that cycle's recorded authority generations. This runs after the authoritative cycle mutation and uses the existing
configured operation timeout and cancellation-aware deadline clock. It never calls the model, waits for an original
deadline, revives a decision, or scans historical terminal cycles. Unattempted and abandoned outcomes retain the
original evidence semantics. A missing, unexpired, foreign-cycle or failed cleanup remains explicitly logged as
incomplete; typed failures, defects and cleanup timeout do not replace the committed terminal receipt. External
interruption still cancels and joins cleanup without undoing the terminal state. This is evidence closure, not a
durable retry queue or a guarantee against process death after the terminal commit.

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
into its version-two execution receipt; a completed research-capture event carries the same references alongside
the controller invocation ID. Each hash resolves the exact persisted observation, whose manifest identifies its
snapshot and whose existing batch plans identify candidate requests and terminal receipts. Store access does not
prove that an observation was selected, submitted, traded, or profitable.

The `complete` flag describes only this pass's reference collection, not complete controller knowledge or capture
coverage. Ordinary passes can create entry and management observations; pending-batch recovery has no fixed count.
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
  authority. Its readiness checks PostgreSQL, ledger, broker reconciliation, and the bound execution controller.
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

Use `node dist/forward-performance-command.js --authority-generation <generation-hash>` to scope the report to a
native mandate without these settings. Only complete absence is optional: partial or malformed historical settings,
including inconsistent evaluation bounds, still fail configuration before evidence reads. A legacy or mixed-history
scope without historical settings fails with an explicit error before any market query or ClickHouse acquisition;
it never omits legacy requests, selects a default snapshot, or implies zero trades or zero performance.
Historical SIP verification retains its explicit evaluation start; intraday archive evidence and immutable receipt
identities keep their existing contracts. Replay/backtest and historical acquisition tools retain their separate
`BAYN_BACKTEST_*` and `BAYN_HISTORY_*` settings.

The live manifests require a binary with this configuration separation. For upgrades from a binary that still
requires daily snapshot settings at live startup, publish and select the new binary before removing those settings.
Before rolling back to such an older binary, restore all eight settings in each of the service, execution-controller
and activation manifests, and deploy that restored configuration with the compatible binary first. Only then select
the older binary through the existing Kargo delivery path. No database migration or evidence rewrite is involved.

The forward-performance command emits `bayn.forward-performance-report.v2`. Its `inferenceExpenses` section joins
all claimed requests, including no-trade cycles, to frozen quotes and verifies the complete account/session set in
TigerBeetle ledger 7002 before attributing estimates to the requested authority generation. Amounts retain USD_PICO
precision. Missing quotes, usage gaps and unverified acknowledgements remain explicit. The stored v3 trading receipt
is unchanged. `operatingCostCoverage` remains `INCOMPLETE` until invoice and other operating-cost evidence exists;
tariff estimates cannot establish fully costed profitability.

### Private inference operating-cost report

The forward-performance ledger reader verifies trading transfers and broker fees. It has no operating-expense
coverage: `otherChargedCostsMicros`, `netRealizedPnlAfterCostsMicros`, and `netRealizedReturn` remain null, with
`OPERATING_COST_EVIDENCE_GAP` and profitability `UNDETERMINED`. Verified gross trading P&L and fees remain visible.
Exact trading reconciliation does not prove inference, data, infrastructure, or research expenses are zero.
Complete implementation shortfall also remains unresolved without explicit cost evidence. Existing immutable
receipts keep their original bytes and hashes; this correction applies to newly computed reports.
Tariffs and expense packets are configured on the private command below. Their account/session scope is not
silently applied to a generation or window report.

Inference expenses are distinct from broker cash and execution fees. The read-only operator command reads claimed
Jev requests across all cycles for one account and exchange-session date, including blocked and no-trade cycles:

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

```sh
node dist/inference-cost-command.js --ledger-session 2026-10-06
```

This mode needs the database/account settings above plus `BAYN_TIGERBEETLE_ADDRESSES` and the normal cluster ID
(default 2001). It reads the frozen tariff rather than accepting a replacement rate card. It verifies every original
request graph, the full scoped TigerBeetle account and transfer sets, and posted balances. `coverage` lists missing
quotes, pending verification and priced-usage gaps; `completeMeteredCoverage` requires all three to be zero.
The report gives the source cut and ledger observation times separately. Concurrent posting can fail reconciliation
and must be retried rather than accepted as a matching subset. Even complete metered coverage remains an estimate:
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
- `GET /v1/status`: bounded controller, strategy, authority, cycle, reconciliation, accounting, build, and blocker
  state.

`executionSession` in `/v1/status` reports the current session's business readiness separately from process health and
startup ownership. `PREOPEN` and `WARMUP` require realized PAPER authority, clear kill state, exact reconciliation,
zero unresolved mutations, an account-bound broker and a matching active Restate controller with a durable pass.
They do not require a snapshot before the first full rolling window exists. `INPUT_UNAVAILABLE`,
`EVALUATION_UNAVAILABLE`, `DECISION_LAGGING`, `BLOCKED` and `RECOVERY_ONLY` are not ready. An ordinary no-trade result is
`ABSTAINING`; it is distinct from a blocked session. The authenticated shared
`BaynExecutionController/<account-key>/activateDeployment` handler verifies deployment ownership and handoff, warms
the private broker-observation owner, and waits for a completed native successor pass. Its verified result remains
available for seven days, and the activation Job logs the invocation ID. The journal is removed at completion so the
bearer header is not retained with the result. Private activation, deactivation, ticks and
status handlers retain exclusive state mutation or shared reads as appropriate. Deployment activation alone does not
establish trading readiness.

For the pinned Jev protocol, the first complete observation is 30 minutes and two seconds after submission opens.
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
portfolio. Entry and management decisions additionally bind the completed inference batch. The corresponding log
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

Without that option, the command evaluates account history, which may span retired strategies and mandates.
An account-history report that includes legacy daily SIP evidence requires the historical settings described above.
Native-only account history does not. A native scope without completed executions remains unqualified; successful
configuration loading is not a profitability result.
The command emits `bayn.forward-performance-report.v2`. Its `receipt` contains the unchanged v3 financial receipt;
`positionEpisodes` measures completed entry-to-flat episodes separately from fill transactions. `inferenceExpenses`
attributes ledger-verified session estimates to the requested generation, and `operatingCostCoverage` remains
`INCOMPLETE` while other operating charges are unknown. `reportHash` binds all four fields. The report does not
change the immutable per-generation receipt schema.
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

## Replay and backtesting

`bayn-gap-recovery` is an offline, original-receipt decision replay command in the
service image. It implements the fixed gap-recovery entry rule, with a separate
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
The verified capture export and source hashes bind original bytes and receipt coordinates. Callers must verify the
capture interval and source bytes through `replayResearchCaptureInterval` and `openBacktestSource` before using its cursor.
Malformed inputs fail with a typed error. The result remains `UNQUALIFIED` with controller coverage `UNKNOWN`.
It does not prove capture completeness, train a model, produce an executable snapshot, or change Jev's 30-minute
contract. Capture interval verification remains the caller's responsibility before economic research.

The [offline Ridge pair](../../docs/bayn/six-bar-ridge.md#offline-paired-portfolio) uses explicitly admitted
control-study input v6 and artifact v2. It compares the seven-feature score with the genuine training-only
day-weighted target mean under the same fixed-principal budget and mechanical execution rules. Native
30-minute-plus-two-second eligibility is unchanged. It uses original-capture six-bar observations and the
existing serial portfolio; missing inputs remain incomplete even when the baseline would choose cash. It grants
no production registration, qualification or capital authority.

### Bounded mechanical control and turnover comparison

The explicitly opted-in `bayn.control-study-input.v4` adds the research-only
`SPY_RELATIVE_SHOCK_REBOUND_60S_V1` falsification candidate described in
[control portfolios](../../docs/bayn/control-portfolios.md#frozen-residual-shock-falsification-candidate).
It uses the same offline portfolio and execution accounting, with a frozen exact-rational signal and a
poll-delayed 60-second exit target. It is not a profitability claim, qualification, production strategy registration,
or trading activation. Legacy v2/v3 inputs retain their original three policies and definition hashes.

`bayn-control-study` supports the strictly offline `MECHANICAL` management mode, which creates no provider
client, broker account, database or capital authority. Its three fixed control policies share the native control
portfolio's point-in-time quotes, finite displayed-liquidity consumption, IOC partial fills, fee accounting, loss and
drawdown limits, close deadlines and explicit missing-data outcomes. A mechanical control is not an exact replay of
the production Jev decision/persistence pipeline and is not a matched live-performance claim.

`bayn.control-study-input.v3` requires `turnoverPolicy`: `IMMEDIATE_ADJUSTMENT` preserves the existing entry-admission
calculation; `ENTRY_AND_EXPECTED_EXIT` additionally reserves the proposed entry limit notional and a modeled future
sale at reference price plus the risk policy's bounded allowance. The integer calculation rounds costs upward,
respects existing reservations and whole-share sizing, and cannot authorize an order itself. Legacy v2 study inputs
keep their previous immediate-adjustment behavior. The reservation applies only to control entry sizing; it cannot
block risk-reducing exits, and a price move beyond the modeled allowance can exceed the reserved amount. It is not
a hard bound on unknown future exit prices. Production entry sizing, turnover mandates and exit exceptions are
unchanged by an offline experiment.

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
native replay. Select `MECHANICAL` management explicitly to remove model decisions, or `JEV` to manage each repeated
control's own position through native Jev evaluation. The retained close control remains mechanical. Timing and
execution assumptions still require calibration before the frozen acceptance experiment.

`src/intraday-replay/control-management.ts` constructs native Jev management inputs from a control's simulated IOC
fill, cost basis, fees and verified held-symbol snapshot. A recorded management decision must match that control's
ledger and expected batch and commit within its original deadline. An accepted model exit keeps its trigger through
partial fills and later IOC retries. In `JEV` mode the control command records requests before inference in a new
exclusive simulation journal, retains paid responses before advancing deadlines, and includes known and unresolved
model charges in its report. An interrupted directory cannot be restarted or overwritten. These records represent
simulated controls and never supply production authority or replace production persistence checks.

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
row-order-independent retained replay, one-micro quantity/notional boundaries, cash and cost-basis conservation,
authority/freshness failures, and exact decimal acceptance thresholds against an independent bootstrap oracle.
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
  --test-name-pattern 'property: a one-micro oversell' --timeout 150000
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
