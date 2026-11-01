# System assessment

These modules report a registered PAPER policy against its economic, matched-control, reliability, safety, and
realism requirements. Current bootstrap outputs are research diagnostics, not a coverage certificate. `evaluateSystemAssessment` is pure; the capture and persistence paths bind its input to
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

`validateSystemRegistration` admits `bayn.system-registration.v3`: a nonempty prospective calendar, candidate and at
least one selected matched control, source/image/prompt identities, cost weights, actual inference tariffs, original
deadlines, statistical assumptions, allocation, and a bootstrap plan. Block length, replicate budget, and seed are
immutable before the first open. The allocation must fit every bound source-approved risk policy. Both existing
PAPER and live-style risk variants are recognized without changing their limits or issuing a capital grant.
Selecting the deployed control still requires its frozen identity; selected ablation and momentum definitions derive
from their native runtime policies. Unknown or expanded risk material and substituted controls remain invalid.
Contracted inference discounts are permitted; all costs still require evidence.

The candidate requires continuous Jev and OpenAI model tariff coverage from the first open through the final close.
The chart ablation requires OpenAI coverage. The frozen deterministic deployed control and repeated momentum do not
require inference tariffs. Missing models, expired rates, and gaps reject registration before its terms become immutable.
Replay requests use `bayn.backtest.v10` and the same `bayn.inference-rate-card.v1` contract as operating-cost reporting.
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

## Evidence and assessment

`captureSystemSourceCut` reads the registered accounts and authority generations, financial and inference records,
source observations, decisions, mutation events, fills, cash observations, and durable controller witnesses. Missing
accounts or evidence remain missing; a submitted assessment packet cannot replace captured facts with claimed profit
or reliability. The capture checks each account's risk, source, image, strategy, and protocol against registration.

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
including losses, downtime, blocked decisions, and zero-trade costs. The bootstrap preregisters its dependence block,
seed, and finite work budget. Its nominal error allocation covers absolute profit and selected comparisons across attempts only if the constituent bounds have valid coverage.
See the [statistical procedure](../../../../docs/bayn/jev-migration-validation.md#statistical-comparison).

Current assessments include `STATISTICAL_COVERAGE_NOT_ESTABLISHED`, retain observed profit and bootstrap diagnostics,
and cannot emit established edge or `QUALIFIED_PAPER`. Known violations still reject; otherwise the result is
inconclusive. No fixed calendar length or activity quota repairs the missing coverage argument. A future inferential
method requires its own justified assumptions and versioned policy before it can establish qualification.
A complete failed window and an incomplete window retain distinct outcomes. Source calendar evidence must support
the market and hours claimed. The supported reference calendar remains broker-observed US regular sessions;
that scope does not establish continuous-market performance.

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
Migrations 169 and 170 admit only current v3 registrations under the research-only qualification policy, preserve ordered attempts and append-only financial history,
and support selected controls and preregistered bootstrap terms. New registrations require the current policy.
Retained v2/v3/v4 acceptance records keep their original terms and policy identities;
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

Build the service, then use `dist/forward-performance-command.js` with the existing private reporting configuration.
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
6. `--authority-generation <sha256> --assessment <sha256>` includes the saved assessment in the scoped financial
   report. `--persist-receipt` also persists that forward-performance report.

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
