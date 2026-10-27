# System assessment

These modules evaluate a registered PAPER policy against its economic, matched-control, reliability, safety, and
realism requirements. `evaluateSystemAssessment` is pure; the capture and persistence paths bind its input to
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

Empty classes and unfinished observation windows remain `UNDETERMINED`. Duplicate evidence, orphan completions, and
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

`validateSystemRegistration` binds the twenty-session calendar, candidate and three controls, source/image/prompt
identities, operating-cost weights, inference tariffs, risk policy, original deadlines, and statistical assumptions.
The deployed control retains its frozen identity. The ablation and momentum definitions derive from their native
runtime policies. Expanded risk limits, substituted control identities, overlapping calendars, and reduced Jev tariffs
cannot become valid registrations.

The candidate requires continuous Jev and OpenAI model tariff coverage from the first open through the final close.
The chart ablation requires OpenAI coverage. The frozen deterministic deployed control and repeated momentum do not
require inference tariffs. Missing models, expired rates, and gaps reject registration before its terms become immutable.

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

`bindSystemSourceCut` constructs session economics and operational obligations from that cut. Cash and inventory
reconcile against fills, cost basis, funding, passive yield, and paid operating expenses. Opening, closing, minute,
and observed intraminute marks retain losses across sessions. Unknown valuations or request clocks prevent a
complete marked-risk assessment. Failed inference remains chargeable even when its provider start is unknown.

`evaluateSystemAssessment` keeps actual net profit, conservative qualification profit, statistical edge, reliability,
realism, and safety separate. Numerical qualification uses the frozen acceptance implementation and every registered
session. The result exposes assumptions, missing evidence, and contradictions. Only the conjunction of all gates can
produce `QUALIFIED_PAPER`; a complete rejected window and an incomplete window retain distinct outcomes.

Latency stress replays the selected native policy with recorded response occurrences and the registered execution
model. CHART, BASE_START, and Jev retain separate costs and clocks. Replay image verification binds the immutable
manifest, executable, dependency receipt, and native policy identity. A separate container-daemon observation binds
the executed command and retained input/output files. The receipt states this trust assumption; image membership
alone does not prove that an execution occurred.

Migration 157 retains source cuts, assessment receipts, replay execution receipts, controller observations, and
durable evidence witnesses as append-only records. A later settlement or newly captured source produces a new
assessment receipt. Reading a saved assessment recomputes its result and verifies its hash. Broker mutation routing
retains the original admission, dispatch, and completion times, including explicit non-dispatch.

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
evidence; implementation tests do not establish those claims. Pinned offline Lean proofs and mandatory conformance
release gates remain the next integration boundary.

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
