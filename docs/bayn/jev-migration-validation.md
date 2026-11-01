# Jev migration validation

## Request recovery

The signal builder accepts the verified streaming or simulated snapshot type and reproduces its retained raw and
derived source evidence before constructing model input. Technical feature availability, window, source references
and content must reproduce the snapshot identity. A matching symbol alone is insufficient.

Jev evaluation requests require a persisted candidate observation matching the exact cycle, authority generation,
snapshot, candidate symbol and observation time. Excluded candidates cannot acquire a request. The store verifies the
observation's content hash before claiming the request and again on historical readback. Before creating or resuming
an inference claim, it also reconstructs the exact candidate/benchmark state and pinned questions from the retained
source. Valid metadata cannot disguise substituted model input. Historical request bytes remain readable for audit;
superseded input definitions cannot resume inference through the entry path.

Requests commit before inference. Each request has one immutable resolution: `RECORDED`, bound to its
receipt hash, or `ABANDONED`, with a recovery time at or after the request deadline. Receipt persistence and resolution
commit in the same transaction. Recovery and result recording lock the request row, so the first committed resolution
wins. These operations reject ambient transactions to preserve their independent commit boundary.

A provider response that arrives after abandonment remains in the receipt table for replay and cost analysis. It cannot
replace the abandoned resolution or authorize entry. A crash before a result commits leaves a pending request until
`recoverExpiredJevEvaluation` records abandonment after expiry. Recovery never issues another inference for that request.
`JevEvaluationStore.read` verifies historical request, receipt and resolution identities without applying a current-time
entry check. `evaluateJevOnce` continues to enforce freshness before returning usable inference.

The PostgreSQL integration tests kill separate workers after request and result commits, remove their temporary files,
then recover with a new process using only PostgreSQL. They also test concurrent recovery, late receipts, immutable
records, canonical migration of existing receipts and ambient-transaction rejection. These are persistence proofs; the
active trading strategy still requires Jev batch binding and runtime integration.

## Complete candidate batches

`makeJevTradingSignalBatch` takes the complete retained observation and a bounded expiry. It derives cycle,
generation, observation and protocol identities from that evidence, reconstructs the source once, and freezes every
candidate request or source exclusion. `reproduceJevTradingSignalBatch` requires the same complete observation and
rejects a rehashed plan with unrelated source hashes, changed input or an omitted candidate.

Batch results bind one outcome per planned candidate. Recorded failures, abandonment and unattempted candidates
remain visible. Selection requires all requested candidates to have usable recorded results and checks freshness
against the entire batch completion time and the current time after persistence. No candidate can be selected while
another result is missing. These pure contracts do not persist batches or grant authority; durable orchestration and
the native decision binding remain unfinished.

## Economic acceptance

The active policy is `bayn.jev-acceptance-policy.v4` in
[`acceptance.ts`](../../services/bayn/src/jev/acceptance.ts). It evaluates the exact nonempty calendar registered
before its first open, with the candidate and at least one prospectively selected matched control.

Current numerical acceptance requires positive fully costed net profit, a strictly positive lower bound for mean
net profit, strictly positive paired net-edge lower bounds against every selected control, and compliance with the
source-approved risk policy. There is no fixed session count, trade quota, turnover quota, dollar profit target,
control-profit multiple, or dollar edge hurdle. Removing the best session, adding ten basis points per filled leg,
and replaying p95 latency are diagnostics rather than admission requirements. Unknown diagnostic results stay null.
Actual execution costs and observed failures remain in the base economics.

[Acceptance v1](jev-migration-acceptance.json), [v2](jev-migration-acceptance-v2.json), and the
[retained v3 policy](../../services/bayn/src/jev/retained-acceptance-policy.ts) preserve their historical terms.
Their records and content hashes remain intact. Stored assessments are verified under their recorded policy;
new registrations use the current policy and continue the existing attempt index. No numerical result grants
trading authority or establishes future returns.

## Run the numerical checker

From `services/bayn`:

```sh
bun tools/jev-acceptance.ts --protocol
bun tools/jev-acceptance.ts --input /absolute/path/to/session-summaries.json
```

The first command returns the active policy and its canonical hash. The second reads
`bayn.jev-acceptance-input.v1` and emits one JSON report. It exits successfully only for
`NUMERICAL_TARGETS_PASSED`; complete failures return `TARGETS_MISSED`, missing evidence or an uninformative
whole-window bootstrap block returns `INCONCLUSIVE`. Malformed or mismatched input fails before a report is issued.

The input contract requires a prospective lock, an ordered calendar, registered analysis terms, and distinct series
for `JEV` plus one or more selected controls: `DEPLOYED_BAYN`, `REPEATED_MOMENTUM`, or `JEV_ABLATION`. Selecting the
deployed control still binds its original lifecycle and six frozen commitments. Source, policy, prompt, continuation,
execution, cost, account, and calendar identities are verified by the system assessment, not by summary arithmetic.

Analysis terms bind the allocation, approved loss and drawdown limits, mark cadence, bootstrap block length,
replicate budget, and seed. Production derives these terms from the registered allocation, source-approved risk
material, decision interval, and bootstrap plan. Registration cannot expand execution authority. The actual market
calendar evidence must cover the claim. The implemented broker calendar remains US regular sessions;
continuous-market evidence is a separate requirement, not supplied by this cleanup.

Every policy series retains every registered session in order, including blocked, losing, and zero-trade sessions.
Complete sessions record actual episodes, filled buy-plus-sell notional, net P&L, continuous opening/closing equity,
marked extrema, drawdown, and mark coverage. Missing base economics or required marks prevents a pass. The optional
p95 stress has a separate status; supplied replay evidence must still reproduce its provenance and terms.

Money fields accept finite JSON numbers between -$1 billion and $1 billion. Nonnegative fields retain their domain
constraints. Arithmetic interprets each decoded number's canonical decimal spelling exactly, using shared integer
coefficients for sums, comparisons, stress deductions, and bootstrap sums. Only displayed values convert back to
JavaScript numbers. JSON decoding has already discarded precision beyond the decoded number. The one-micro-dollar
equity-consistency tolerance does not relax acceptance comparisons.

The checker consumes summaries. Independently reproduce them from complete fills, fees, cost basis, cash movements,
settlement, valuations, and operating expenses. Spread and slippage in actual fill prices are deducted once. Additional
ten-basis-point charges appear only in the diagnostic counterfactual. Current qualification uses actual invoiced
consumption; the retained greater-of-tariff-or-invoice premium is reported separately and does not replace actual
profit. Unknown required costs remain unknown, including during zero-trade and failed-operation sessions.

## Statistical comparison

Before the first open, register circular block length `L`, replicate count `R`, and a nonzero UInt32 xorshift seed.
Each resample has exactly `N` registered sessions, truncating only its final block when necessary. Candidate and
controls share sampled indices. The block start is the exact integer floor of unsigned PRNG state times `N`, divided
by `2^32`. Blocks longer than the calendar are invalid. A whole-window block gives no resampling variation and
cannot establish edge; this is reported as inconclusive rather than a fictitious precise estimate.

Let `m` be the number of selected controls and `k` the immutable attempt index. The one-sided tail allowance for
each of the `m + 1` claims (absolute mean net profit and each paired mean net edge) is:

```text
alpha = 0.05 / ((m + 1) * k * (k + 1))
```

This spends the familywise error allowance across both claims and attempts. Registration requires
`R >= 20 * (m + 1) * k * (k + 1)`. The percentile rank is computed with exact integer division as
`floor((R - 1) / (20 * (m + 1) * k * (k + 1)))`. The lower bound is the selected sorted resampled total divided by
`N`. Both absolute and paired bounds must be strictly positive. A losing control cannot replace absolute profit.

There is no fixed twelve-attempt ceiling: later attempts must prospectively reserve adequate finite work. Preserve
all failed and inconclusive attempts; do not reset the index or increase the bootstrap budget after seeing results.
The method assumes the selected block length adequately captures dependence and the prospective sample supports
the claimed distribution. These assumptions remain explicit in the assessment. A passing estimate does not prove
future returns or authenticate source evidence.

## Score response consistency

TypeSafe defines Score as the probability-weighted value of the ordered levels in its
[API contract](https://docs.typesafe.ai/api). The recorded provider probe includes a score of 1.63 whose reported
probabilities imply 1.65. Exact equality would reject that observed response.

Bayn therefore permits a rounding error of at most 0.005 per probability and per score. It computes the lowest and
highest possible weighted means within those intervals, enforcing total probability mass of one and probabilities
between zero and one. A score outside that feasible interval is rejected. This is an explicit Bayn tolerance, not a
TypeSafe guarantee of decimal precision. The original score and probability values remain unchanged in evidence.
The tests preserve all five recorded Score responses and reject contradictions, including a maximum score with all
probability on the lowest level.

## Reproduce focused checks

From the repository root:

```sh
bun test services/bayn/src/jev/contract.test.ts services/bayn/src/jev/acceptance.test.ts services/bayn/src/jev/acceptance-current.test.ts
```

The broader Bayn component checks remain required. Successful unit tests, a numerical pass on synthetic fixtures and
a valid provider response do not complete the production migration or the joint economic objective.
