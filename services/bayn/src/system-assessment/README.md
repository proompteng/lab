# System assessment

These modules report a registered PAPER policy against its economic, matched-control, reliability, safety, and
realism requirements. Current statistical qualification uses prospectively registered conditional support and exact
microdollar bounds. Retained bootstrap outputs remain research diagnostics. `evaluateSystemAssessment` is pure;
the capture and persistence paths bind its input to
immutable source records. An assessment never admits an order or grants capital authority.

## Economics

`cashInventoryTradingPnl` reconciles the change in cash-and-inventory equity after removing external funding and
passive cash yield. It adds back operating expenses paid from the trading account so the operating-cost report can
deduct those expenses once. `netTradingPnl` computes realized profit plus the change in unrealized profit, less
execution costs, with explicit cash-settlement rounding.

`binaryTradeEdge` represents `p * gain - (1 - p) * loss - cost` as an exact rational number of micro-USD. The break-even
probability is `(loss + cost) / (gain + loss)`. Positive edge requires the supplied probability to exceed that value;
an attractive target/stop ratio alone does not establish edge. The probability is an input assumption, not an estimate
established by this function.

`markedRisk` measures maximum drawdown and maximum loss from the opening mark on the supplied equity path. Its caller
must supply the complete, cash-flow-adjusted, cost-inclusive path and verify mark coverage. Missing session profit
propagates through `advanceQualificationEquity` instead of becoming zero.

## Reliability

`measureReliability` evaluates decision work, reconciliation, mutation handling, and recovery independently against
999/1000. A successful obligation has a correct durable completion no later than its original deadline. Scheduled
work that never starts stays in the denominator. The failure allowance is `floor(scheduled / 1000)`.

An empty recovery class is `NOT_APPLICABLE` when the source-bound schedule has no recovery obligations; it is not
100% measured recovery. Empty required decision, reconciliation, or mutation classes and unfinished observation
windows remain `UNDETERMINED`. Retained policy versions keep their original empty-class behavior. Duplicate evidence, orphan completions, and
impossible timestamps fail validation. Safe failures and late recoveries count as missed service. Safety violations
are evaluated separately by the combined assessment and have no error budget.

Operational reporting uses `bayn.operational-registration.v1` in the `BAYN_OPERATIONAL_RELIABILITY` program. It binds
one existing native PAPER policy, its sealed capital generation and physical execution build, the unchanged runtime
deadlines, the compiled runtime entry scope, and a prospective contiguous reporting period.
The current scope is equities only; retaining the mixed-market capital protocol does not re-enable crypto entries. The registration retains
the earlier incident evidence. Its scope source is the canonical equity calendar captured before registration;
an unexpected empty or substituted calendar cannot be treated as a legitimate closure. Its attempt chain is append-only; a later period cannot erase an earlier failure.
There is no research control, bootstrap, profit quota, minimum session count, or trade quota in this operating claim.

New operational registrations bind the native execution controller's plan identity directly. The optional
read-only status expectation is not that identity and cannot replace or remove it. PostgreSQL rejects new missing
or substituted plan bindings. Earlier registrations and receipts retain their original contents and results;
the first operational attempt with a missing plan remains incomplete or failed rather than being rewritten.

Controller projection observes the committed status in a separate database statement before returning.
This supplies a durability witness without waiting for another trading tick. The observation cannot witness
its own transaction or released savepoint; rolled-back and deferred-rejected sources remain unwitnessed.
Repeated observations preserve the first witness and the original completion time, epoch, sequence and deadline.

The native schedule keeps globally aligned signal and reconciliation times. One exact post-due reconciliation may
complete several pending checks for the same account; each check retains its own original freshness deadline, and
a late reconciliation cannot repair an expired obligation. Starting a report does not restart the
signal warmup or an admitted mutation's clock. Obligations due before the final reporting boundary keep their original
deadlines afterward. Capture retains the whole event sequence for mutations active across the opening boundary,
including unresolved work with no event inside the period. A report remains incomplete while required evidence or
original deadlines are outstanding. Closed entry windows count only with retained calendar, policy, account,
generation, physical worker and causal arrival evidence. Bare historical closed ticks and read-only capital holds do not
prove correct decision work. Closed evidence preserves the original admission clock through calendar I/O.
The reporter reproduces the native admission rule and the registered day's hours before accepting the abstention.

Operational accounting requires the reader's exact fill/receipt and ledger verification, the complete retained
transaction and cash-settlement rows, and the existing cash-settlement identity checks. Economic qualification
remains separate; open inventory or an unpaid, accounted fee liability does not impose a new operating quota.

`evaluateOperationalAssessment` shares the financial evaluator's schedule, durable witnesses, integer reliability
measurement, capital identity checks, and safety audit predicate. Its separate immutable receipt can report
`OPERATIONALLY_RELIABLE_PAPER`, `REJECTED`, or `INCONCLUSIVE`; economics remain `NOT_ASSESSED`. No operational receipt
can certify economic qualification or grant capital. Operational safety audit artifacts bind the exact coverage,
registration, evidence cut, violations and verified scan-evidence hash. A verified unrelated file cannot certify zero violations. An operating period's dated scope does not establish behavior
outside that period or substitute for the required native equity-opening verification.

Operational capture validates every inference source, frozen quote and native ledger prefix before retaining source
fingerprints and complete quote and ledger evidence. It omits raw inference bodies from the operational cut; economics
remain `NOT_ASSESSED`. Financial capture retains each complete inference request once, with its source fingerprint in
the accounting material. Session reads paginate all retained cost records rather than rejecting sessions above a
fixed record count. Immutable source tables and earlier cuts and assessment receipts remain unchanged.

New operational cuts use `bayn.operational-source-cut.v1`. Capture reads native decisions and controller receipts
one row at a time in the original repeatable-read snapshot, spools their complete canonical bytes privately, and
archives each source once in append-only `system_source_records`. The immutable cut retains their hashes and native
identities. This avoids constructing a whole-period JSON string containing repeated multi-megabyte decision bodies.
The shared controller-evidence query expands each retained JSON status once before filtering and deduplication,
avoiding repeated decompression of large pass payloads. It preserves distinct observations, identity and window
filters, cross-boundary execution starts, and the original database deadline.
Operational capture uses the verified registration's original runtime configuration, even after the reporting service
has upgraded. The capture build is recorded separately. Replay still binds every execution source to the registered
policy, generation, build and original deadlines; a reporting upgrade cannot substitute new clocks or certify work
from a different execution policy. Prospective registration continues to require the current physical runtime.
Controller pass capture uses active completion projections. Deactivation preserves the last completion summary while
advancing the controller epoch; it does not perform that pass again. Its inactive projection cannot reattribute the
earlier receipt to the new epoch. The original completion and every raw projection remain retained, and conflicting
active evidence still fails capture.
Already-stored inactive projections replay exactly without rewriting their retained pass; they do not count as new completed work.
The archive is persisted before the manifest, and PostgreSQL rejects missing references, repeated native identities,
and operational manifests attached to financial registrations. Interrupted capture can leave retained archive rows;
retry verifies and reuses their exact contents rather than replacing evidence.

Whole-session decision reads retain premarket and later decisions as source context, including the original owners of
inventory and mutations carried into the reporting period. Their market, universe and native exchange session must
match the registered policy. Context outside the registered reporting window cannot complete scheduled decision work;
the original window and deadlines still determine every numerator and denominator.

Assessment reads every referenced source and runs the same decision, execution-plan, admission, controller and durable
witness checks used for retained full cuts. Correctness counters are derived during replay and cannot be supplied by
the manifest. Missing, substituted or malformed sources fail verification. Existing `bayn.system-source-cut.v4` cuts
and their receipt hashes remain reproducible. Financial qualification continues to require its full financial cut;
an operational manifest cannot certify profit. Temporary spool files are private and removed when capture exits,
including failure and interruption.
The trading API's private financial reporter has a 4 GiB disk-backed temporary volume. Its former 256 MiB volume
cannot hold a complete native session's evidence. That allocation does not provision the separate qualification
operator environment or the deployed research worker. Verify private spool capacity before starting qualification
capture. Exhausted storage fails capture without dropping records or creating a successful assessment; trading
deadlines, reliability targets and worker resources remain unchanged.

## Realism

`measureRealism` verifies causal input availability, persistence and routing order, position ownership, fixed order
terms, fill quantity and precision, limit prices, and execution deadlines. Conservative model fills also require
verified liquidity capacity and cannot assume favorable price improvement. Repeated fills consume shared capacity.
Actual broker receipts retain their explicit evidence kind.

The function reports `VIOLATED` for contradictions and `INCOMPLETE` for absent evidence or unsupported assumptions.
The caller supplies the expected decisions and fills and a set of verified source hashes; source-cut admission must
bind those identities to the registered policy, account, generation, and window. `SUPPORTED` here does not establish
complete costs, statistical edge, or a combined qualification verdict.

## Prospective registration

`validateProspectiveSystemRegistration` admits only `bayn.system-registration.v7` under qualification policy v8.
Stored prior versions retain their original registration, policy hashes, and assessment paths. Each v6/v7 policy definition carries a complete
`bayn.research-strategy-binding.v1`: engine, concrete parameters, strategy identity, and protocol hash. Candidate
and `INCUMBENT_JEV` are comparison roles; either may explicitly bind Jev v44 or intraday alpha v2. Their role names
and the shared internal strategy name `jev` never select an implementation. The incumbent must match its separately
witnessed serving generation, including its complete strategy material. Native admission binds a candidate and an `INCUMBENT_JEV`
control to separate account and authority identities under the same execution risk policy. The incumbent's
PostgreSQL store locks its active PAPER authority through candidate admission and writes its own witness.
The candidate store seals the pair after the peer witness commits. Both commit deadlines precede the first
open. An interrupted attempt without a peer witness remains incomplete and retains its attempt index.
Admission also binds the nonempty
calendar, source, image, prompts, cost weights, inference tariffs, original deadlines, allocation, and conditional
statistical support before the first open. Current registrations
have no bootstrap plan. The allocation must fit every bound source-approved risk policy and match each account's
verified opening equity at the first session. Subsequent sessions use their own observed equity. Both existing
PAPER and live-style risk variants are recognized without changing their limits or issuing a capital grant.
New registrations bind the explicit equity entry scope and the complete canonical Alpaca calendar as a verified
source artifact. Both application and database admission recompute the calendar's source and normalized-response
hashes. The execution and reporting windows use the same native equity hours derived from this calendar.
This preserves daylight saving changes, holidays, shortened sessions, and the native controller's deadline
alignment. The financial market scope can also retain markets for existing-position exits. Historical runtime
commitments without an entry scope still require every market in their original protocol.
Capture requires reconciliation through the final broker recovery window. Transactions between registered
windows or after the final native data close within the broker recovery window leave economics incomplete.
For each native qualification date, capture computes the expected equity charges from the full account equity fills
and registered dated fee schedule. Every equity fill must belong to the registered policy and window. The expected
fee amounts must match distinct posted activities on that date, and each activity must belong to the policy's verified
financial evidence. The registered rate supplies the comparison amount. Posted receipts supply the actual cost.
Terminal inventory, unresolved orders, the independent cash bridge, and operating costs retain their evidence requirements.
Native registration, capture, and assessment read the incumbent store through
`BAYN_QUALIFICATION_INCUMBENT_JEV_POSTGRES_URL`. The connection inherits the candidate's TLS mode. Set
`BAYN_QUALIFICATION_INCUMBENT_JEV_POSTGRES_CA_PATH` when the incumbent uses a different CA. Registration writes the incumbent
witness. Capture and assessment use read-only PostgreSQL connections. Capture also reads
`BAYN_QUALIFICATION_INCUMBENT_JEV_TIGERBEETLE_CLUSTER_ID`, `_TIGERBEETLE_ADDRESSES`, and
`_TIGERBEETLE_LEDGER` for the incumbent. The cut records each account's snapshot time. Assessment
checks the incumbent seal and cash prefix against that account's store and its own cutoff.

After broker recovery, native financial capture reads an authenticated Alpaca non-trade statement for every registered
PAPER account. `--system-capture` uses the configured broker connection for the candidate. The private command's
environment supplies a separate `BAYN_QUALIFICATION_<POLICY>_ALPACA_KEY_ID` and
`BAYN_QUALIFICATION_<POLICY>_ALPACA_SECRET_KEY` for each registered control. Use the registered policy value in the
variable name, such as `INCUMBENT_JEV`. The command uses the existing PAPER endpoint and proxy and verifies each
credential pair against the account in that policy's registration. It fails the cut if any statement is missing, names
a different account, or was observed after the database snapshot. The activity read scans all non-trade types, follows
provider cursors to an empty terminal page in both directions, and requires the same normalized rows. The private
source cut retains the original JSON response bodies, recorded response digests, requested creation-time interval,
and actual observation time. Assessment checks each digest and derives the activity rows and cursors from those
bodies. This statement covers the provider's reported activity during that interval. Capture also retains actual
before-open, broker recovery, and later
exact reconciliation cash observations with their inventory witnesses and fee posting timestamps. The reconciliation
transaction retains the exact account event and position snapshot it compared. Settlement capture uses that pair.
Historical reconciliations without the durable pair provide no settlement witness. For independent opening and recovery
observations, inventory must precede or coincide with the cash event's economic timestamp.

Native assessment uses a fee-adjusted cash path for flat equity endpoints, exact fills, and later posted fees with
no other cash movements in the statement. It uses the registered effective-dated fee schedule. When TAF applies,
the cash path requires exact posted charges and a total sell fee at or below the per-trade cap. This makes the
charge independent of how partial fills are grouped into trades.
The cash leg starts at observed opening cash, adds receipted trade cash and rounding, and subtracts incurred fee
prefixes. The assessment reconstructs it from the underlying retained account records, settlement snapshots, and
both authenticated activity page chains. Stored calculated cash points cannot supply a risk mark. The recovery
bridge checks physical cash before the late fees. The later bridge independently checks the
full fee debit. Cash or fee contradictions withhold financial evidence. Retained physical observations and the
assessment's after-the-fact availability remain explicit. Opening liabilities, early debits, accrual matches,
unsupported activity classes and other schedules require additional evidence before use in qualification. Other
registered accounts require their own authenticated activity source.

An inventory quote used for financial valuation also retains a later arrival from the same contiguous journal.
The later arrival must be strictly after the valuation mark. The quote itself must already have arrived by the mark.
Reaching a journal's end does not establish coverage after its last durable arrival. Financial valuation provenance
does not substitute for the trading controller's observed market-data inputs.
Selecting the deployed control still requires its frozen identity; selected ablation and momentum definitions derive
from their native runtime policies. Unknown or expanded risk material and substituted controls remain invalid.
Contracted inference discounts are permitted; all costs still require evidence.

The v37 and v38 candidate and chart ablation require continuous Jev tariff coverage from the first open through the final close.
Retained historical protocols still require their original provider tariffs for financial verification. The frozen deterministic deployed control and repeated momentum do not
require inference tariffs. Missing models, expired rates, and gaps reject registration before its terms become immutable.
Retained replay requests use `bayn.backtest.v11` or the engine-bound `bayn.backtest.v12`; new registrations use
`bayn.backtest.v13` with independently witnessed baseline preparations. All use the same
`bayn.inference-rate-card.v1` contract as operating-cost reporting. Required provider models derive from the bound
engine. The current alpha v2 policy disables catalyst veto, so its replay acquires no provider client and requires
zero provider dispatches and retained calls. This does not waive broker, data, infrastructure, or other operating costs.
Adjacent periods may have different prices. Each retained call uses the registered provider/model rate effective at its
simulated start, with per-call rounding retained. Missing, overlapping, or substituted rates leave usage unresolved.
The replay binder retains the complete registered schedule; replacing it with one fixed price fails source binding.

`registeredSchedule` derives decision and reconciliation obligations from the locked calendar and configuration.
Polling frequency cannot remove scheduled work from the denominator. Cost allocation uses positive, canonically
ordered weights and cumulative integer rounding, preserving the exact invoice total and all outside-window shares.
The Node regression exercises all 468,000 reconciliation obligations at a one-second cadence across twenty full sessions.

`initializeQualificationHistory`, `registerSystemQualification`, and `readSystemRegistration` retain canonical,
content-addressed documents. Migration 156 makes history and registrations append-only, serializes admissions on the
program row, and requires the next attempt index and predecessor hash. Both insertion and deferred transaction
completion must precede the first open. Retries return the same registration; failures and candidate changes cannot
reset the attempt history. These functions require verified audit and allocation-source hashes from their caller.

### Native engine replay and timing

New economic registrations bind `bayn.qualification-runtime.v3`, the explicit candidate strategy, and latency stress
protocol v5. Version pairing is exact:

| Registration                   | Source cut | Replay input | Replay report | Alpha baseline evidence                       |
| ------------------------------ | ---------- | ------------ | ------------- | --------------------------------------------- |
| v7                             | v6         | v13          | v11           | Independent preparation and committed witness |
| Retained v6                    | v5         | v12          | v10           | Original observation and committed witness    |
| Earlier retained registrations | v4         | v11          | v9            | Original retained engine contract             |

Historical runtime v1/v2 and all stored hashes remain reproducible. A newer input cannot replace a retained input,
and a polling replay cannot establish a streaming registration.

The replay image's compiler receipt v5 binds its complete root strategy and explicit compiled engine catalog.
Each candidate or incumbent executes the exact strategy in its own registration. The native broker, risk checks,
order terms, shared liquidity, partial fills, fees, accounting and recovery remain the execution path. A declaration
of alpha with a Jev executable fails identity binding.

Versions 12 and 13 schedule work from retained arrival times, observable broker transitions, and native deadlines.
The live controller and replay share the successor deadline and market-eligibility calculation. Suppressed market
hints still advance their frontier; they cannot reappear later as new arrivals. Broker changes wake independently.
Arrivals during work are serialized after the active pass. Reporting cuts preserve the owner and its pending
deadline. They do not create a trading poll or a forced terminal trade. Registered streaming stress requires an
original-capture delivery receipt; reconstructed archive timestamps cannot stand in for original availability.

Source-cuts v5 and v6 retain standalone alpha observations even when no funded decision exists. Their source transaction
queues an `ALPHA_OBSERVATION` evidence row. A later committed native controller observation supplies the independent
durability witness. Observation `observedAt` is a logical source timestamp, never a commit time. There is no historical
backfill. Rolled-back sources, released savepoints, direct witness inserts and uncommitted rows cannot establish
availability. Missing witnesses stay unknown.

Retained v12 alpha baseline carriers retain the complete source observation, its hash, the independent witness hash, and
availability time. The provider reproduces each observation and uses only the trailing baseline matching the exact
session, provider, feed, topics, universe and lookback, with strictly prior baseline dates. Source portfolio state and
short eligibility are not copied into the replay account. The baseline must already be available at the decision's
original observation cut; a later processing clock cannot make it causal. A registered carrier array must exactly
match the authenticated source cut. Standalone v12 fixtures remain declared research input, not qualification evidence.

The first alpha observation of a session cannot retroactively witness its own earlier baseline availability. Without
an earlier independent witness, replay records `MISSING_CAUSAL_ALPHA_BASELINE`, including the first later availability
when known, and withholds complete results. A later successful decision does not erase that gap. A Jev candidate's
source cut also cannot invent an alpha incumbent's missing baseline inventory. These cases require additional retained
source evidence before economic qualification; changing timestamps or treating the gap as no-signal is invalid.

### Prospective baseline preparation

The native alpha path prepares its baseline on the existing native wake before regular-session warmup. It retains
the canonical query, actual daily and checkpoint rows, coherent adjusted-daily fallback snapshot, acquisition start
and completion, and reproduced trailing baseline. Adjusted and raw series are not spliced. The immutable preparation
binds the account, authority generation, cycle, session, full policy, calendar and physical execution build. Its scope
excludes the cycle identity so subsequent cycles reuse the first committed source; a new physical build has a new scope.
Restart and cache reuse preserve the original acquisition and database timestamps.

Preopen acquisition requires every requested daily baseline and noise checkpoint before it can become that immutable
source. Incomplete preopen reads are not cached or committed; a typed pending-coverage outcome defers the native hook
to its existing first regular-minute wake. This boundary uses the actual acquisition `startedAt` and the target
provider session's regular open. Finishing or committing an earlier partial read after the open cannot reclassify it.
A fresh acquisition beginning at or after the regular open preserves the strategy's existing partial-symbol and
partial-checkpoint behavior. This preparation condition does not add a whole-universe entry gate.

Migration 225 records the source and pending evidence in one transaction. A later native controller observation can
witness only committed source and pending rows. Only an already committed v7 registration matching the candidate
policy, build, account, generation and calendar can enqueue qualification evidence. Registration must commit before
the first native open; acquisition begins within that native session. Late registrations cannot backfill evidence.
The server rounds source time upward to milliseconds, and the observer leaves a source pending until its own clock
reaches that time. Caller timestamps, rollbacks, releasing a savepoint without committing its outer transaction,
and direct witness inserts cannot establish availability.

Native decisions require the preparation to have been recorded by the original `EntryObservationContext.observedAt`,
before refreshed eligibility and snapshot reads. If acquisition finishes later, that pass defers to the next existing
native wake. Warmup does not roll back a completed preparation. Research v13 uses a stricter boundary: the independent
witness must be available by the actual `runPass` command's `commandIssuedAt`. Its baseline-use v2 receipt retains
that command, original admission, deadline, preparation hash, witness hash and baseline hash. External verification
reselects the source at the same command cut; a later admission or snapshot clock cannot admit it.

Source-cut v6 retains the complete preparation inventory and independently committed witnesses, alongside alpha
observations for latency calibration. A registered v13 input must exactly reproduce the independently witnessed
preparation array derived from that cut; unwitnessed sources remain visible only in the cut. A compatible alpha
incumbent may reuse the candidate's pure market baseline only under the same full policy; the producer remains
the candidate, while the incumbent retains its own account, portfolio, eligibility, authority and build. An incompatible
policy or missing peer-engine source remains unavailable. Replay never fetches a fresh provider baseline as a fallback.

An unwitnessed first preparation remains `MISSING_CAUSAL_ALPHA_BASELINE` and withholds complete economics. Later
successes do not erase it, and standalone supplied-source fixtures are not qualification evidence. Native and compiled
replay tests establish execution and provenance behavior; prospective source capture, complete costs and economic
qualification still require actual evidence.

`measureRegisteredDecisionLatency` selects the engine's calibration. Jev retains its full-batch measurement; alpha
uses reproduced observations and decisions or verified abstentions, separately bounded pass references, independent
durable witnesses, and complete submission/recovery histories. Resolved failures remain timing samples. Missing
sources, references, original commands, routing or unresolved submissions withhold the complete percentile. Alpha
controller samples must also match the registered physical source and image digest. All
registered controller windows remain in the reliability denominator. The shared `p95FullBatchMs` intervention field
retains the command-through-durable-completion bound; alpha's report identifies observation counts explicitly and
does not invent inference batches. The same floor applies to each control's own actual completion, preserving expiry
and downstream pricing/risk checks. A measured percentile or a passing replay test does not establish profit.

## Evidence and assessment

Source cuts retain each complete batch once in `batches`; the provenance material does not copy those payloads.
Earlier cuts retain their original bytes and hashes. Run `bayn-system-assessment` from the research image with the
existing explicit trading-target reporting configuration. The trading API retains `bayn-forward-performance`, not
the qualification command; the deployed research worker's restricted identity is not a financial-report credential.
Verify the authorized operator environment's memory and private spool capacity separately. The API financial reporter's
3 GiB Node heap and 4 GiB memory limit are capacity context, not evidence that another workload is configured to report.
Stream command output to a private file. A local capacity measurement using 540 copies of one retained
514 KB batch exceeded Node's string limit with duplicate payloads. A single copy serialized 279 MB with a
2.62 GiB process peak. This is reporting capacity evidence, not trading or reliability qualification.

`captureSystemSourceCut` reads the registered accounts and authority generations, financial and inference records,
source observations, decisions, mutation events, fills, cash observations, and durable controller witnesses. Missing
accounts or evidence remain missing; a submitted assessment packet cannot replace captured facts with claimed profit
or reliability. The capture checks each account's risk, source, image, strategy, and protocol against registration.
Native fee evidence binds the retained Alpaca account response and both activity scans to the same registered account
as its ledger and settlement anchors. Missing statements leave that account's session economics unresolved.
Economic capture returns the source-cut hash and latency measurements. The raw broker evidence stays in the private cut.
Runtime capture preserves the original unscoped hash of historical financial registrations that omit `entryMarkets`.
All originally committed runtime fields must still match; registrations that include entry scope retain its exact
hash commitment. Capture stores the matching runtime shape without rewriting the immutable registration.
A persisted historical registration with a null controller plan also keeps that null commitment when the current
builder supplies the native plan, whether its entry scope is present or absent. Capture still queries the registered
null plan, so it cannot borrow native controller observations. Non-null plans, scoped entry markets, and all other
runtime fields retain exact hash checks. New operational registration admission still requires the native plan.

IOC fills bind expiry to the retained broker order's filled, canceled, or expired terminal instant. Capture retains
the order identity, quantities, receipt hash, occurrence time, and observation time. Unknown, still-open, or
not-yet-observed orders cannot supply expiry; conflicting identities or fill totals reject the binding. DAY orders
expire at the earlier of the registered session close and a retained terminal instant. GTC orders require a retained
terminal instant before their expiry is established.

Source-cut v4 retains the complete normalized broker order and each fill's broker order ID. Native bracket children
retain the parent intent while keeping separate order identities, limits, requested quantities, and cumulative fills.
The binder reproduces each profit or stop leg from the sealed native protection plan and the recorded parent/child
relationship. It rejects changed prices, ownership or leg identities and checks the shared disposal budget against
entry fills already observed in time order. Broker-adjusted residual quantities can be fractional; the submitted
bracket parent must retain its whole-share quantity. Missing parents, siblings, routing or observations remain
incomplete. The result exposes the broker observation and normalization assumptions explicitly.

Separately armed replacement OCO and standalone-stop intents bind their own immutable intent, approved risk decision,
exact fresh reconciliation, and independently committed submission admission. The binder reproduces their IDs and
sealed exit prices from the original entry, retains the approval's submission deadline, and shares chronological
entry inventory across original protection, replacement groups, and explicit closes. Equity OCO uses whole shares
and DAY; standalone stops preserve native DAY or crypto GTC terms and fractional quantities. Missing admissions or
omitted actual fills remain incomplete. Source sequence determines the order of fills with equal timestamps.
Financial coverage uses these same independently captured fills and includes each protection approval as its own
decision. The entry-only forward execution projection cannot omit a protective exit from session accounting.

Exact-cent cash movements need no rounding settlement because every supported broker reporting quantum divides one
cent. A present settlement must still match its trade and be posted by the evidence cut. Sub-cent movements without
authenticated rounding evidence remain incomplete. Cash projection indexes cumulative changes once and preserves
unresolved debit intervals. Inventory reconstruction advances through sorted observations, retaining coin-debit
uncertainty and supporting earlier independent endpoint queries without carrying later holdings backwards.

Fill pricing distinguishes reproduced spot quotes, actual native protection, and actual mandatory liquidation under
the existing reconciled-position binding. Conditional broker receipts do not invent a quote at the later fill time.
Model fills still require a fresh quote and supported liquidity. The result exposes the authenticity assumptions for
broker normalization, retained risk approvals, reconciliations, and conditional execution. Content hashes alone do
not authenticate an approval. Supplied protection decisions are replaced by the captured evidence before evaluation.

The replay mutation store advances its owned clock to a committed admission timestamp before returning that admission
to the coordinator. Standard and recovery drivers use this same store. Routing snapshots read the clock passively;
the existing submission synchronization determines dispatch time once. This preserves causal admission evidence and
the original market-arrival sequence while retaining complete routing receipts.
Concurrent recovery may invalidate a cached reconciliation before submission. The guard retains a durable denial
before dispatch; recovery must reconcile again before closing. The runtime regression binds every additional rejected
close to that exact observed conflict and verifies no broker order, duplicate fill, or accounting effect.

`bindSystemSourceCut` constructs session economics and operational obligations from that cut. Cash and inventory
reconcile against fills, cost basis, funding, passive yield, and paid operating expenses. Opening, closing, marks
at least as frequent as the registered decision interval, and observed intrainterval marks retain losses across sessions. Unknown valuations or request clocks prevent a
complete marked-risk assessment. Failed inference remains chargeable even when its provider start is unknown.

`evaluateSystemAssessment` keeps actual net profit, the policy-bound qualification basis, statistical edge,
reliability, realism, and safety separate. Current qualification and marked risk use actual fully attributed costs;
the operating-cost report retains the tariff premium as a diagnostic. Retained versions reproduce their original
conservative deductions. Unknown costs, missing usage clocks, unresolved settlement, or missing valuations do not
become zero.

Current numerical requirements are positive total net profit, positive lower bounds for mean profit and every
selected paired net edge, and compliance with the registered source-approved loss and drawdown limits. Trade counts,
turnover, control-profit ratios, best-session removal, ten-basis-point stress, and p95 latency are diagnostics.
Missing stress evidence leaves that diagnostic unresolved; supplied contradictory evidence still rejects binding.
There is no fixed session count. Candidate and selected controls must cover every registered session exactly,
including losses, downtime, blocked decisions, and zero-trade costs.

Native `bayn.system-registration.v5` and v6 registrations require `statisticalPlan.method: CONDITIONAL_HOEFFDING_V1` and one
prospective support interval, source artifact and explicit assumption for every selected policy. They have no
bootstrap or replicate budget. `economic-qualification.ts` uses actual fully attributed session net profit and exact
conditional Hoeffding lower bounds for the candidate and every paired control. Its estimand is average registered
expected session net profit over the fixed calendar, not future or stationary returns. Supports are assumptions about
the complete policy, including costs and failures; observed extrema and stop limits do not establish those assumptions.
The registered `meanModel: DETERMINISTIC_CONDITIONAL_SESSION_MEANS` assumes each session's conditional expected
net profit given prior information equals its expected net profit given registration information. Session means
may differ across dates; this is not inferred from observed returns. There are no default production support bounds. Out-of-support observations reject the model rather than being clipped.

The result retains support assumptions, conditional MGF, registered mean model and causal-filtration assumptions, exact alpha, integer radius
and rational mean bound. The familywise 0.05 budget is shared across all claims and immutable attempts. Missing evidence
cannot qualify. Failed statistical targets report `NOT_ESTABLISHED`; an incomplete result remains `UNDETERMINED`.
See the [statistical procedure](../../../../docs/bayn/jev-migration-validation.md#statistical-comparison).

Stored `RESEARCH_EVIDENCE_V5` assessments retain `STATISTICAL_COVERAGE_NOT_ESTABLISHED`, their original bootstrap outputs
and policy hash. Earlier registration versions retain their original rules. New admission uses the current policy
identities and extends the immutable attempt history. The private reporting
command owns current assessment. `tools/jev-acceptance.ts --retained-input` reproduces the retained v5 numerical research
checker and is not a current qualification route.

A complete failed window and an incomplete window retain distinct outcomes. Source calendar evidence must support
the market and hours claimed. The current reference calendar covers broker-observed US equity trading hours.

Latency stress replays the selected native policy with recorded response occurrences and the registered execution
model. CHART, BASE_START, and Jev retain separate costs and clocks. Replay image verification binds the immutable
manifest, executable, dependency receipt, and native policy identity. A separate container-daemon observation binds
the executed command and retained input/output files. The receipt states this trust assumption; image membership
alone does not prove that an execution occurred.

The frozen `DEPLOYED_BAYN` control uses `bayn-frozen-control-backtest`. Its original single-position and session-close
engine is compiled from Git revision `ef6a069fc121cbe54d148027fe091e3e7f58da9b`; the compiler authenticates the complete
original service tree and records the consumed source, dependency and adapter hashes. A newly registered image can
carry this executable. The original three policy identities, execution model, empty provider set and exit lifecycle
remain frozen at both application and PostgreSQL admission. The image verifier reads the dedicated executable and
compiler receipt, and the execution observer requires that exact offline command.

`bayn.frozen-control-replay.v1` binds the complete original protocol, captured-arrival bytes, every registered
sessions, common instrument terms and execution assumptions, original operation deadlines, and the measured candidate
calibration. Its replica derives from this complete scope, preventing a different stress from reusing a broker account.
The adapter releases each original committed entry or closing document after both its actual completion and the
registered command-to-decision floor. Source arrivals advance before control returns to the original coordinator;
the original expiry and post-release risk checks remain effective.

The report verifier retains each original document and reconstructs fills, source-quote capacity, precision, limit
prices and original release deadlines. Broker activities, exact PostgreSQL numeric tokens, posted charges and ledger
receipts must reconcile. Six-decimal legacy quantities convert exactly to the current nine-decimal quantity unit;
prices and cash remain micro-USD. The shared session accounting evaluator then applies all registered operating costs.
Unknown costs remain unknown, and a missing verified image or independent execution receipt withholds stress economics.

The existing backtest ledger gate runs the complete original twenty-session control against isolated PostgreSQL and
TigerBeetle. Its fixtures are generated and consumed by the pinned Node runtime, including the retained chart-image
bytes used by candidate calibration. Each independent fixture has a distinct registered synthetic history, so prior
TigerBeetle effects cannot be mistaken for a fresh account. Registry tests also exercise the frozen executable's image
membership, byte tampering and subprocess cancellation. Synthetic spread losses and operating charges must survive
the full evidence join; these tests establish no prospective profit or qualification.

Observed native replay containers retain a read-only root, read-only `/evidence`, and writable `/result`.
Set `TMPDIR=/result` so source preflight can create its scoped, unlinked private snapshot there. The observer
requires that exact scratch destination and rejects other temporary paths, extra mounts, tmpfs mounts, or injected
runtime settings. Database targets remain the only other permitted environment additions. A latency replay uses
its prospectively registered operation timeout; the CLI does not replace it with the ordinary replay default.

Migration 159 retains source cuts, assessment receipts, replay execution receipts, controller observations, and
durable evidence witnesses as append-only records. A later settlement or newly captured source produces a new
assessment receipt. Reading a saved assessment recomputes its result under the policy recorded in its registration and verifies its hash.
Migrations 169 and 170 retain the historical v3 research registration contract. Migration 182 admits current v4
registrations with conditional statistical support, preserving ordered attempts and append-only financial history.
Retained v2/v3/v4/v5 acceptance records keep their original terms and policy identities;
they are verified through the same evaluator, without reopening admission under that retired policy. Broker mutation routing
retains the original admission, dispatch, and completion times, including explicit non-dispatch.

Source inserts enqueue pending witnesses in the same PostgreSQL transaction. Controller observations consume only
committed pending rows for the registered account and plan, preserving the first witness time. Savepoint release
does not establish durability, and deferred rejection rolls back the source and its pending witness together.
The queue does not use an ID or timestamp watermark, so transactions that commit out of order remain eligible.
Consumed rows leave the queue; subsequent controller updates do not rescan historical source tables.
Reconciliation correctness retains its result at completion. Later submissions do not invalidate a successful
preflight reconciliation; their freshness and recovery requirements remain separate obligations.

The source cut also captures immutable decision-admission receipts. A submission trigger records a receipt only when
the decision source is already committed and its account, generation, strategy, policy, cycle, and ordered intent
match the admitted mutation. Mutation admission rejects ambient transactions and commits before broker routing.
The source binder joins that receipt to the producer's actual routing event to establish an upper bound on decision
commitment. A later controller observation alone leaves pre-routing persistence incomplete. The assessment records
these persistence assumptions explicitly, and the qualification policy hash commits to this evidence rule.

## Private reporting command

Build the service, then use `dist/system-assessment-command.js` (`bayn-system-assessment` in the research image)
with the existing private reporting configuration for the trading member of the same immutable source cohort.
This operator command does not use the deployed research worker's restricted credential as a financial credential.
Evidence packets contain `payload` and an `artifacts` array of `{ sha256, path }` entries. Paths resolve relative to the
packet; their bytes must match their hashes. A hash authenticates bytes, while provider provenance remains an explicit
evidence obligation.

1. `--system-history <packet.json>` admits the audited prior attempt history once.
2. `--system-register <packet.json>` freezes a registration before its first session. The configured runtime protocol
   and deadlines must reproduce its commitment.
3. `--system-capture <registration-sha256>` captures and persists an immutable source cut.
4. `--system-capture-replay <packet.json>` observes a retained replay container and persists its execution receipt.
5. `--system-assess <packet.json>` verifies source bindings and replay images, evaluates the assessment, and appends
   its receipt.
   Use `bayn-forward-performance --authority-generation <sha256> --assessment <sha256>` in the trading image
   for the scoped financial report. `--persist-receipt` also persists that report. The financial-report command no longer
   accepts qualification flags; each command has one owner and no compatibility route.

The same history, register, capture, and assess commands accept operational packets. Their program and schema select
the operational evaluator. Current `bayn.operational-assessment-input.v3` packets contain only the saved
registration and source-cut hash. The evaluator derives the native safety audit from the same cut; supplied clean
audit declarations are rejected. Results bind `evaluationPolicy: bayn.operational-native-safety.v1` and retain each
native check, its source identity and the explicit provider and database assumptions.

Migration 181 adds append-only authority-at-registration, authority-transition and mutation-admission journals in the
original PostgreSQL transactions. Rollback removes the original write and its journal together. Existing registrations
are not backfilled with invented authority baselines. Capture retains the currently published full broker observation,
raw durable order/fill and intent/risk records, and the complete account ledger and cash settlements. A missing
baseline, broker observation, ownership, authority transition or accounting record yields incomplete evidence; known
unauthorized effects or invalid risk terms remain violations. No order is submitted to create coverage.

Counters and successful-event totals come from committed witnesses. Operational registration still requires verified
calendar/scope and retained incident artifacts and the existing durable authorized generation. Registration and
reporting do not change trading authority or risk limits. Stored v1 and v2 inputs reproduce their original immutable
receipts only on historical read and cannot enter current assessment admission.
Their original source/digest controller comparison is frozen separately from the current build matcher.
Those historical results do not establish a certificate under the current build-binding rule.
Stored v37 operational registrations also preserve their original frozen protocol schema and exact default parameter
hash from `4467bce540bb135b96a59b1ee37396885914df0a`. Historical registration, source-cut and receipt readers can
reproduce those bytes; current registration and assessment admission still reject v37. The synthetic fixture
`original-v37-operational.test-fixture.json` was generated from that source's fixture and evaluator with the current
Effect 4.1.4 test harness. Its original registration, source-cut and inconclusive receipt hashes are fixed regression
goldens. It contains no production account evidence, and replay grants no trading or economic qualification.
Archived v37 position holds also retain that exact default parameter hash. Only the verified v37 operational
source reader selects their historical decoder; current position-hold, controller, registration and assessment
admission stay strict. The shared pure hold calculation reproduces the original evidence without current defaults,
while canonical archive, hold, source-cut and receipt hashes remain mandatory. The synthetic held-controller golden
in `original-v37-held-controller.test-fixture.json` was generated by the native fixture, hold decision and public
receipt reader at `0506c9d7eec58844f78e893158dd9027ab69b86d`, using Effect 4.1.4. It fixes the original rejected
outcome and rejects unknown policy hashes, changed parameters, deadlines and noncanonical archive bytes.
Its portfolio domain stays long-only with positive quantity and cost basis and no short plan. It also excludes
the protection-evidence marker introduced by `adb5213ced690a551b0b83eb1a56561a73661f64` under v41. Resealed
negative fixtures first validate through the general current portfolio and shared calculation, then prove that
these later features cannot enter the historical reader. Current long and short management remain unchanged.

A bounded read-only replay on 2026-11-21 used the existing seven operational receipts and 1,650 archived references
(1,608 unique records), with exact captured PostgreSQL text supplied to the public source functions. All seven
receipt hashes reproduced: six remained `INCONCLUSIVE`, and one remained `REJECTED` with 550
`UNBOUND_CONTROLLER_BUILD` entries and `INCOMPLETE_SAFETY_AUDIT`. All remained economically `NOT_ASSESSED`.
This verified source-function replay, not a deployed HTTP endpoint, and created no assessment, registration,
approval, inference or financial effect.

Compact source replay carries the selected policy only in verified in-memory evidence; its immutable manifest is
unchanged. Current evaluation checks every retained controller build, including unwitnessed passes, using small
receipt/timing summaries without retaining complete archived records. A replay-policy/input mismatch is rejected.
Current assessment of a retained registration with a null controller plan adds `UNBOUND_CONTROLLER_PLAN` even
without captured controller passes. Independent decision witnesses cannot replace this missing provenance;
historical v1 receipt reproduction and new-registration admission retain their original separate rules.

Retained controller passes must match the registered physical worker build through the reporting period and any
remaining original obligation deadlines. A missing or mismatched build adds `UNBOUND_CONTROLLER_BUILD` and prevents
operational certification, even when independent decision documents complete scheduled obligations. A pass known to
start after that period and all required work has completed cannot invalidate the finished claim. This exemption
requires ordered issue, observation and completion clocks ending no later than the cut; missing or contradictory
clocks remain fail-closed. Retained source documents and measured obligation counters are not discarded or rewritten.

The financial report derives its operating-cost status from the bound assessment. Without a matching assessment,
unverified costs remain explicitly incomplete. Profitability, edge, and qualification require actual prospective
evidence; implementation tests do not establish those claims. Pinned offline Lean proofs and production conformance
are mandatory PR and exact-main image-publication gates. Run `bun run --filter @proompteng/bayn verify:formal` from
the repository root on Linux; see the [formal verification prerequisites and coverage](../../formal/README.md).

## Validation

From the service directory:

```sh
bun test src/system-assessment
# Actual PostgreSQL contracts require an isolated local database whose name ends in _test.
BAYN_TEST_POSTGRES_URL=postgresql://localhost/bayn_registration_test bun test src/system-assessment/postgres.integration.test.ts
```

The tests include arithmetic properties, positive trading profit consumed by costs, zero-trade operating losses,
missing cost evidence, absent scheduled work, independent class targets, future inputs, unsupported liquidity,
partial fills, timing contradictions, source substitution, invoice reuse, late settlement, retained replay stages,
immutable assessment receipts, and rejection of a transaction that commits after its first market open.

Historical runtime decoding accepts the exact retained v28 through v35 protocol contracts and original control
prompt identities. New registration and replay execution require the current protocol. Historical policy selection
uses both acceptance and qualification identities before reproducing an immutable receipt. Original bytes, hashes,
failed attempts, and financial records are never upgraded to current semantics.
