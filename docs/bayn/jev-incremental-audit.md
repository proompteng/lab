# Jev incremental-value audit

This is a research contract and executable synthetic audit, not a real-market result, a registered experiment,
or a trading-policy change. It introduces no provider calls, broker access, capture activation or capital authority.

## Verified boundaries

The production request in `src/jev/trading-signals.ts` contains candidate and SPY minute bars, quote/trade ages,
rolling values, computed returns/volatility/volume ratios and optional technical indicators. Entry selection in
`src/jev/decision.ts` ranks qualifying `action.probabilities.enter`; the separate `confidence` field and
`setup_quality.score` do not drive that selection. The 0.65 action score is not a 65% probability of net profit.

TypeSafe's [confidence definition](https://docs.typesafe.ai/confidence) summarizes a choice distribution's
concentration. With three options, a largest probability of 0.65 corresponds to confidence 0.475 under that formula.
Neither quantity establishes financial calibration. The provider's
[Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) warn about numerical precision and
choice-order effects. Those limitations motivate tests; they do not demonstrate a failure on Bayn observations.

The request schema pins `jev-1.13.0`, but has no seed or temperature control. Deterministic request construction,
retained output reproduction and provider repeatability are different claims. Replay retained outputs; do not
replace them with later answers. Freeze exact serialized request bytes, question/option order, model identifier,
request/response hashes and boundary timestamps. A future, separately authorized repeatability/permutation study
should report decision flips and threshold crossings without selecting the most profitable permutation.
Contemporaneous retained answers also avoid retroactively querying a model that may have learned about an old
evaluation period. A prompt's instruction to use only supplied facts is not proof against that contamination.

## Executable audit

Run from the repository root:

```sh
bun test services/bayn/src/intraday-replay/jev-incremental-audit.test.ts
bun test services/bayn/src/intraday-replay/matched-entry-command.test.ts
```

The tests call actual request construction, snapshot reproduction, matched lifecycle, order/ledger and summary
functions:

- Independently valid snapshots with identical prices but different optional technical inputs must not compare
  equal. The original comparison failed this regression despite different Jev request hashes.
- Technical value changes and source-coordinate changes must bind separately; future technical availability
  cannot form a valid request. Changing observation time changes quote ages and model session context and must bind.
- A synthetic path makes Jev outperform delayed momentum after inference cost, while immediate momentum beats
  Jev. The existing matched study can correctly recommend a further portfolio test on its narrower estimand.
- A missing post-entry stop observation keeps the complete-case headline unavailable.
- An earlier abstention lets one portfolio take a later opportunity while the other remains occupied.

These tests verify software behavior. Repeated synthetic opportunities are not independent evidence, and do not
estimate Bayn's alpha, real delay cost, capacity or statistical significance.

## Freeze three entry arms before collecting outcomes

All three use the same immutable pre-model candidate set, model-feature cutoff, initial budget, mechanical
50 bp stop, 15-minute maximum hold, five-minute close window, routing assumptions and fee/capacity model.
Use exact benchmark-relative momentum with the existing symbol tie-break; do not tune a new numeric filter.

1. **Immediate momentum:** choose the deterministic top candidate at its first verified feasible decision time.
2. **Delayed momentum:** retain that same candidate and ranking, but route at the actual complete Jev batch time.
3. **Jev-filtered:** use the original complete Jev decision at that batch time.

The immediate time is not the bar timestamp, exchange timestamp, historical REST timestamp, or a guessed
subtraction of API duration. It requires original input availability plus bounded evidence for local feature,
ranking and routing readiness. Record both candidate computation and batch request/completion/expiry times.
Require fresh executable quotes at each arm's decision and arrival; do not reuse the earlier quote as a fill.
The delayed control holds its information set and ranking fixed so the comparison does not mix re-ranking
with elapsed time. Unknown decision feasibility leaves the immediate arm unavailable.

Keep two economic estimands explicit:

- Selection effect: Jev-filtered net outcome minus delayed momentum net outcome.
- Delay effect: delayed momentum outcome minus immediate momentum outcome.
- Total incremental value: Jev-filtered net outcome minus immediate momentum outcome.

On the same fully observed opportunity denominator, selection plus delay equals total increment. Charge all
Jev requests, failures, abstentions and unselected candidates to the Jev arm. Report selection before and after
model cost; do not assign a fictitious inference bill to delayed momentum. Shared infrastructure allocations
cancel in relative outcomes only when genuinely identical. Absolute net performance still includes them.
Use base and frozen stressed costs; retain unknown costs instead of replacing them with zero.

Both delayed arms must use a predeclared common fallback time on known timeout/abandonment. Distinguish a verified
fail-closed no-entry decision from missing model evidence. The existing matched study conservatively treats
unavailable answers as incomplete; changing that rule requires a new protocol, not post-hoc deletion.

## Cohort and missingness

Define the observation schedule independently of every arm's actual holdings before the study. Retain all
scheduled instants, including no-candidate, no-entry, abstention, failure and holding periods. At each instant
retain the entire point-in-time universe and candidate/exclusion ledger before model output, with reason codes.
Do not define the cohort from submitted orders, completed fills, Jev-selected symbols or the incumbent's flat times.

Bind the capture's complete session/topic/partition/cut inventory and controller-schedule coverage independently.
Retain quote/feature availability for every eligible candidate, not only the realized winner. Missing future
pricing, stop observations, residual inventory or unpriced calls cannot drop an opportunity after selection.
Prespecified pre-model ineligibility is different from post-model missingness. Report both counts and reasons.
Unobserved arrival paths are not recoverable by inventing a counterfactual or treating a later archive as live data.

The current matched-entry study only samples native flat-entry observations and starts both rules after inference.
Its explicit limitations are correct. Its completeness gate does not establish the broader cohort or immediate
decision times above, even after the v2 source-binding repair.

## Management is a separate ablation

First compare the three arms with identical mechanical exits. Then freeze common entry fills and compare
mechanical management with Jev management, including all management inference costs, delays, partial exits,
protective stops, holding deadlines and close-window liquidation. This identifies management conditional on that
entry population. It does not establish an entry benefit.

Management requests include actual held quantity, cost basis, entry time, unrealized P&L and remaining horizon.
An answer from the realized position cannot be transplanted onto a different hypothetical entry or position.
Branch-specific requests/responses would need separately authorized prospective collection. Until then, do not
claim an independent model-management counterfactual from actual held-position observations alone.

## Independent portfolio confirmation

Opportunity labels deliberately overlap. Do not sum them into P&L or average only completed trades. Each arm
needs its own cash, positions, open/pending orders, consumed quote liquidity, turnover, fee accrual, inference
bill and flattening lifecycle, starting from the same capital and existing one-position/20% risk limits.
Use the common exogenous schedule, but let each arm's state determine whether it can act. Do not restrict all
arms to the incumbent's realized entries. Keep losing positions, partial fills and zero-trade sessions.

Opportunity-level delay/selection decomposition is not a causal decomposition of the independently evolving
portfolios: an earlier abstention or exit changes later feasible entries, cash and capacity. Report paired
session-level net P&L against cash and the immediate baseline. Keep original exchange-only liquidity separate
from any consolidated-market execution audit; paper fills do not prove real executable size.

## Calibration and acceptance

Treat the native action probability as an ordinal setup signal until out-of-sample evidence supports a mapping
to a defined economic target. Freeze that target (for example positive net fixed-budget outcome with the
mechanical lifecycle), quote/cost conventions, bins and temporal split. Include all eligible candidates and
abstentions. Fitting a probability calibrator and evaluating it on the same trades is not validation.

Use session-blocked training/evaluation and an embargo at least as long as overlapping label horizons. Compare
the calibrated signal against deterministic momentum and an appropriately simple numerical control with the same
available features. Distinguish selection/ranking lift, probability calibration and expected profit magnitude.
If the raw score targets a different semantic event, a profit reliability plot is a diagnostic, not proof of
miscalibration of the provider's original question.

Five sessions and twenty different choices are feasibility/falsification gates, not twenty independent trials
or proof of profitability. Freeze the observation window, economic minimum, uncertainty method and stopping rule
before collection. Analyze dependence at the session level, preserve failed trials and zero-opportunity sessions,
and do not extend the window until significance appears. Positive selection results only justify independent
portfolio confirmation; no audit result grants promotion or capital authority.
