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

The active policy is `bayn.jev-acceptance-policy.v5`, paired with system policy v5 and
`bayn.system-registration.v4`. The pure [economic evaluator](../../services/bayn/src/system-assessment/economic-qualification.ts)
uses actual fully attributed economics and the exact conditional bounds below. Register the complete policy,
candidate, selected controls, allocation, cost attribution, calendar and statistical support before the first open.

Qualification requires positive actual net profit, a strictly positive lower bound for average registered expected
net profit, strictly positive paired net-edge bounds against every selected control, and the existing approved loss
and drawdown limits. Reliability remains 999/1000 per required class, with zero safety violations. There is no fixed
session count, trade quota, turnover quota, dollar profit target, control multiple, dollar edge hurdle, bootstrap block
requirement or resampling work budget. All sessions remain included, including failures, abstention and zero-trade costs.

Best-session removal, additional ten-basis-point cost and p95 replay remain diagnostics. They cannot replace actual
costs or failures. An assessment never grants trading authority. Conditional PAPER evidence does not establish live
execution, a stationary return distribution or future profitability.

## Reporting commands

Use the supported private reporting command documented in the
[system assessment guide](../../services/bayn/src/system-assessment/README.md#private-reporting-command):

1. `--system-history <packet.json>` retains the audited attempt origin.
2. `--system-register <packet.json>` prospectively binds the v4 registration and verified support-source artifacts.
3. `--system-capture <registration-sha256>` persists the immutable evidence cut.
4. `--system-assess <packet.json>` reproduces the complete financial, execution, reliability and statistical evidence.

A statistical plan has method `CONDITIONAL_HOEFFDING_V1`. It explicitly binds `meanModel: DETERMINISTIC_CONDITIONAL_SESSION_MEANS`. Its `supports` array contains one entry per selected
policy: `policy`, `lowerMicros`, `upperMicros`, `sourceHash`, and `assumption`. Bounds apply to fully costed session net
profit, including execution and operating failures. Source artifacts must be verified before registration. There are
no default production support values. Do not use observed sample extrema or a daily loss stop as a guaranteed support
bound: gaps, execution uncertainty and costs may violate either claim.

The registration's complete policy definitions and append-only hash bind these assumptions to source, account,
strategy, prompts, parameters, execution and costs. Bounds cannot be retuned under an existing attempt. Missing costs,
marks, sources or sessions prevent qualification. An observation outside its registered support rejects the model;
the evaluator never clips it, drops it or substitutes zero. A new attempt preserves every earlier attempt.

The old numerical checker is for retained bootstrap research only:

```sh
bun tools/jev-acceptance.ts --protocol
bun tools/jev-acceptance.ts --retained-input /absolute/path/to/session-summaries.json
```

It prints the retained v5 research identity and `bayn.jev-acceptance-input.v1` diagnostics. Its numerical success
cannot establish current statistical edge or qualification. Retained v2/v3/v4/v5 registrations and assessment receipts
are reproduced under their original policy hashes; their bytes, financial history, attempt indices and results are
never upgraded. The frozen [v2 acceptance contract](jev-migration-acceptance-v2.json) remains unchanged.

## Statistical comparison

The [conditional bound](../../services/bayn/src/system-assessment/conditional-confidence.ts) estimates the average
registered expected session net profit over the fixed calendar under the mean model below. For each policy, let the prospectively
registered support be `[l,u]`, let `n` be the complete calendar size, and let `S` be the sum of actual microdollar profit.
The causal information set includes prior attempts, market inputs, latency, liquidity, failed operation and costs.
The plan explicitly declares `meanModel: DETERMINISTIC_CONDITIONAL_SESSION_MEANS`: for every selected policy and
session, expected net profit given all prior information equals its expected net profit given registration
information. The session means may differ across the fixed calendar; conditional higher moments and outcomes may
remain dependent. This assumption is required for the population expected-profit estimand. A bound for random,
path-dependent conditional means does not establish that same claim. For example, a common positive/negative shock
can produce a persistent favorable path while population mean profit is zero.

Conditional almost-sure support gives a centered MGF bound with parameter `(u-l)^2/4` under this mean model. The
registered sources must justify both support and the mean model. Neither assumption nor provider authenticity
follows from a finite observed sample. All are printed in the result. No full independence or stationary return
distribution is asserted, and this is not a guarantee that Bayn satisfies those assumptions.

For original attempt `k` and `m = 1 + selected control count`, use:

```text
D = 20 * k * (k + 1) * m
alpha = 1 / D
L = ceil(log2(D))
V = n * (u - l)^2
radius = ceil(sqrt(ceil(V * L / 2)))
mean lower bound in microdollars = (S - radius) / n
```

The factor 20 is the reciprocal of the frozen 0.05 familywise error budget; it is not a session requirement.
All gate arithmetic uses integers. The report retains the exact rational lower bound and outward-rounded radius;
only diagnostic currency summaries use floating-point display fields. For a candidate-minus-control comparison, use the paired differences on
the same registered sessions and support `[l_candidate-u_control, u_candidate-l_control]`. Each policy bears its own
fully attributed operating costs. A losing control cannot substitute for positive absolute profit and its lower bound.

The conditional Hoeffding tail is bounded by `exp(-2 * radius^2 / V) <= exp(-L) <= 1/D`. The union budget covers every
selected claim and every immutable attempt: the attempt allocations telescope to at most 0.05. This holds conditional
on prior selection only under the recorded causal filtration and MGF assumptions. Zero-width support represents a
claimed deterministic process; it is not a mechanism for estimating support from constant observations.

`Bayn.ConditionalConfidence` proves integer outward rounding and current qualification gates.
`BaynProbability` proves the conditional tail bound, paired support without independence, the rounding-to-alpha
connection and the program-wide allocation using pinned Mathlib. Both libraries are mandatory `lake check` targets.
The probability proof library stays outside the executable conformance model and the trading runtime. Reachable
synthetic success, missing evidence, the negative-expectancy counterexample, exact finite-sample enumeration and
PostgreSQL admission/history tests exercise the production path.

This procedure follows the conditional-MGF framework and its distinction between changing conditional means and population means in
[Howard et al., time-uniform confidence sequences](https://arxiv.org/abs/1810.08240) and the bounded-variable inequalities in
[pinned Mathlib's SubGaussian module](https://github.com/leanprover-community/mathlib4/blob/56a005855ea17e0b0958f73ec801ae140b0a1679/Mathlib/Probability/Moments/SubGaussian.lean).
It proves a conditional statistical statement, not the market assumptions themselves.

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
