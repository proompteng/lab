# Intraday alpha cost-cohort diagnostic and prospective evidence plan

## Decision

Prioritize prospective execution and basket attribution before changing the three-engine policy. The supported midday trades remain positive across the existing cost scenarios, while the morning and noise results are sensitive to costs and which orders fill. That is a research priority, not established positive expectancy or authority to increase capital.

This diagnostic is tied to production source revision **36d31d6575062cad8d37d2c622955b988e8c788f**, policy **bayn.intraday-alpha-policy.v2**, and the unchanged [audited v2 evidence](../2026-11-26-alpha-v2-replay/results.json). It does not alter that evidence, rerun a parameter search, change the strategy, or register a prospective evaluation.

All 66 August 25–November 25, 2026 calendar sessions remain. November 17 remains unavailable because QQQ's required 16:30 UTC mark is absent; the previously supported position and eventual exit remain. Every complete-window modeled net is still null. Candidate baseline coverage is still partial on 63 sessions. Morning and noise require symbol baselines; midday uses its separate observed-bar eligibility rules. No missing bar or baseline is invented.

## What the diagnostic measures

[The tool](../../../../services/bayn/tools/analyze-intraday-alpha-cost-cohorts.ts) validates the replay fields consumed by this diagnostic, unique ordered calendar, scenario counts, checkpoint availability, modeled fee/price/quantity arithmetic, and ownership of every closed or unresolved leg by a committed attempt. Duplicate entry identities, orphan outcomes and silently dropped dates are rejected.

An entry identity is (sessionDate, phase, symbol, direction, entryAt). Cost-altered quantity, prices and exit outcomes are deliberately excluded from the join key and compared separately. The intersection contains 261 supported closed entries: 45 morning, 168 midday and 48 noise. All 261 preserve quantity, exit timestamp and exit reason across the three scenarios. The tool retains those invariants, membership hashes, every calendar row and unavailable observations in [results.json](results.json).

**The intersection is selected using modeled fill outcomes.** It is an in-sample diagnostic, not an unbiased portfolio, a causal comparison of executable policies or a new holdout. It cannot be traded by knowing in advance which orders would fill under all scenarios.

### Supported common-entry subtotals

These numbers describe only supported closed legs in the selected intersection. They are not complete session or strategy returns.

| Engine               | Common entries | 2 bp round trip | 5 bp round trip | 10 bp round trip |
| -------------------- | -------------: | --------------: | --------------: | ---------------: |
| Morning ORB          |             45 |        −$624.50 |      −$1,001.26 |       −$1,629.21 |
| Midday relative VWAP |            168 |      +$8,128.69 |      +$7,244.78 |       +$5,775.73 |
| Noise-area momentum  |             48 |        +$521.00 |        +$162.13 |         −$435.98 |

The positive morning subtotal at 2 bp depends on seven additional fills contributing $1,319.33. Removing those entries changes membership; it is not an estimate of what disabling morning trading would earn. Noise's four additional 2 bp fills contribute −$567.18, so its total subtotal masks part of the common-entry cost erosion. The number of trades and allocated notional differ across engines; absolute dollars do not establish a normalized ranking.

The supported 2-to-10 bp changes partition arithmetically:

| Engine               | Total supported closed-subtotal change | Common-entry change | Membership contribution change |
| -------------------- | -------------------------------------: | ------------------: | -----------------------------: |
| Morning ORB          |                             −$2,324.04 |          −$1,004.71 |                     −$1,319.33 |
| Midday relative VWAP |                             −$3,847.06 |          −$2,352.96 |                     −$1,494.10 |
| Noise-area momentum  |                               −$389.80 |            −$956.98 |                       +$567.18 |

Quantity and exit clocks happen to match in this input. The tool also exposes changed quantities or exit paths in future inputs, where matched-entry differences would not isolate price-cost effects. All reported sell fees are the replay's hypothetical 0.21 bp charge, not actual broker settlement.

## Economic risks that the next study must resolve

The current implementation supplies useful source records, but they must be connected to financial outcomes.

- **Execution and selection.** Ten-basis-point entry limits and committed-attempt quotas make nonfills part of the economic process. The replay's whole-minute, full-leg fill proxy and one-minute working window differ from native quote deadlines and actual broker execution. Cost stress changes membership, not just P&L on a fixed portfolio. Retain decision, first submission, acknowledgement, every fill, cancel/expiry and original deadline, including attempts that never fill.
- **Midday exposure.** The target derivation balances funded selections, and the executable-basket check bounds planned notional imbalance by whole-share rounding. These are pre-order checks; independently filled legs can remain partial or one-sided. In the unchanged supported 10 bp scenario, 53 selected baskets are partial and 18 filled baskets are one-sided. One-sided basket subtotals contribute $2,321.31 of the $5,775.73 supported midday subtotal. The groups overlap; this is not proof of a dollar-neutral edge.
- **Concurrent attribution.** The source gives noise priority at its checkpoints, with equity fallback when no noise signal exists. Committed entries consume durable quotas even without fills. A later sleeve therefore cannot be treated as an independent strategy with unchanged observations, account headroom and opportunities. Preserve the entry owner for protection and liquidation fills; do not classify an exit using whichever decision happens to be current.
- **Costs and missing economics.** Account totals and metered inference estimates do not by themselves allocate realized equity episode P&L and broker fees to the three sleeves. Unallocated or unsettled fees, borrow/funding if applicable, shared operating cost and open inventory must remain explicit. A fully costed policy claim must reconcile to the canonical account result.
- **Concentration and selection history.** The earlier 66-session corpus, current symbols, research choices and all inspected variants have already influenced development. Neither re-labeling the last third nor keeping only common fills creates untouched evidence. No thresholds, sleeve deletions or confidence claims are selected from this decomposition.

Alpaca's [paper-trading specification](https://docs.alpaca.markets/us/docs/paper-trading) says simulated orders use NBBO, do not check order size against available NBBO quantities, and can receive random partial fills. It also identifies omitted execution and cost effects. IEX observations and PAPER fills can establish their respective recorded events; they do not establish live capacity or live execution costs. Record the reference-price basis explicitly rather than describing an IEX-to-PAPER comparison as observed NBBO execution quality.

## Prospective study design and provenance requirements

This is a preparation plan, **not a registration, economic qualification or trading authorization**. The existing acceptance and authority paths remain responsible for those actions.

1. **Freeze the hypothesis and source before the first new observation.** The primary question is whether the unchanged combined policy has positive net expectancy after every applicable cost. Keep engine and basket results as prespecified diagnostics. Bind the exact production commit, immutable image, policy/behavior/execution-model/risk hashes, account environment, universe, feed and baseline contract. Retain the current study and prior investigations in the trial history. A later policy change starts a separately identified attempt rather than rewriting this one.
2. **Register the complete future calendar and analysis rules.** Use the provider's regular-session calendar, including early closes, and lock the start/end, source cutoff, inference method, risk support assumptions, treatment of unavailable sessions and matched controls before observing those outcomes. Use the repository's existing prospective acceptance mechanism; this diagnostic adds no arbitrary session-count, dollar hurdle or retrospective performance gate. Repeated interim inspection must obey the registered stopping rule.
3. **Preserve decision-time source proof.** For every actually eligible decision window, retain original collector and consumer arrival receipts, bar/quote revisions, benchmark completeness, exclusions, prior-session baseline provenance, original deadline and source hashes. A later historical retrieval remains event-time research and cannot repair original availability. Retain missing and never-started scheduled observations in the denominator.
4. **Bind intended and executed baskets.** Join the immutable alpha target's phase, signals, selected symbols and target weights to its committed entry intents. Carry entry ownership through partial fills, native protection and liquidation. Report committed, submitted, rejected, canceled, expired, wholly unfilled and filled attempts separately. For each basket record intended and filled long/short notional, signed/gross exposure and its duration; distinguish four-leg completion, two-leg completion, fallback and partial/one-sided fills.
5. **Measure net economics at the right boundary.** Reconcile opening inventory, fills, partial closes, realized basis, broker fees, funding/borrow when present, remaining inventory and closing account balances. Publish morning, midday and noise direct net separately, then shared costs and combined fully costed net. Do not allocate shared costs by an arbitrary rule solely to make a sleeve profitable. Unavailable attribution stays unavailable while supported components remain inspectable.
6. **Use matched controls without inventing execution.** Bind each control's price basis, timing, notional, costs and required data coverage prospectively. Preserve no-trade cash and any already registered directional control as distinct hypotheses. Shadow signal markouts can diagnose whether an entry forecast is useful, but do not turn an unfilled or unsubmitted order into executable P&L.
7. **Review the frozen result before proposing a new policy.** Evaluate the registered complete cohort, paired comparisons and the existing acceptance bounds. Treat midday's modeled strength as a hypothesis to test. Cost-sensitive morning/noise results justify measurement priority, not a retrospective instruction to remove them. Any new execution or signal rule needs a separate source identity, declared selection history and untouched prospective confirmation.

The need to retain model-selection history is consistent with [Bailey, Borwein, López de Prado and Zhu, _The Probability of Backtest Overfitting_](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf). This note does not apply their method to the partial corpus or claim a measured overfitting probability.

### Source records already available in the implementation

At the pinned production revision:

- [decision.ts](https://github.com/proompteng/lab/blob/36d31d6575062cad8d37d2c622955b988e8c788f/services/bayn/src/strategy/intraday-alpha/decision.ts) retains phase, signals, selected symbols, planned weights, funded plans and complete decision evidence.
- [runtime.ts](https://github.com/proompteng/lab/blob/36d31d6575062cad8d37d2c622955b988e8c788f/services/bayn/src/strategy/intraday-alpha/runtime.ts) binds source snapshots, trailing baselines and durable session history.
- [candidate-observation-postgres.ts](https://github.com/proompteng/lab/blob/36d31d6575062cad8d37d2c622955b988e8c788f/services/bayn/src/db/candidate-observation-postgres.ts) reads committed intent history for the phase quotas.
- [forward-performance](https://github.com/proompteng/lab/tree/36d31d6575062cad8d37d2c622955b988e8c788f/services/bayn/src/forward-performance) contains the canonical accounting, execution-quality and episode evidence boundaries. Extending equity phase/basket attribution belongs there; this diagnostic does not change it.

## Frozen inputs and reproduction

| Material                         | SHA-256                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| Audited replay source            | bf54605f799011694b7803d64d6bb03bbe44f4a36659030cb00de5825dfb9caa |
| Existing compact v2 receipt      | a7122e783030b971de4b0eda7cb571a7247ece2aeab62a909a72152178d9c8a4 |
| Full replay report analyzed here | b57c5a83acd00f50bd38dd30d154173fb7844259d676f2cee27b7c090cede353 |
| Original bar export              | 6c2753fc2dddae60554a501ef508ffa1568fb51af859b687b29b2dbb7efe4180 |
| Warmup bar export                | f889df193d16911fb52a396be91726fd302248ab0680f86e51a28d5c7391731e |
| Cost-cohort diagnostic source    | 67854272fca185d692ca190b06b3505d8ee186347e44f95a7e96a7d0b8c27cc8 |

The [pinned replay source](https://github.com/proompteng/lab/blob/36d31d6575062cad8d37d2c622955b988e8c788f/services/bayn/tools/verify-intraday-alpha-replay.ts), [calendar](../2026-11-26-alpha-v2-replay/calendar.json), [warmup receipt](../2026-11-26-alpha-v2-replay/warmup-receipt.json) and [original receipt](../2026-11-26-alpha-replay/source-receipt.json) reproduce the full report. The original archived TSVs remain separately hashed inputs; the compact v2 receipt does not contain the per-trade records required by this diagnostic.

From a checkout containing the pinned replay implementation and these diagnostic files:

```sh
bun services/bayn/tools/verify-intraday-alpha-replay.ts \
  --calendar docs/bayn/evidence/2026-11-26-alpha-v2-replay/calendar.json \
  --evaluation-start 2026-08-25 \
  /tmp/bayn-alpha-warmup-20261126.tsv \
  /tmp/bayn-alpha-strategy-20261126.tsv > /tmp/alpha-v2-full.json

bun services/bayn/tools/analyze-intraday-alpha-cost-cohorts.ts \
  /tmp/alpha-v2-full.json > /tmp/alpha-cost-cohorts.json

bun test services/bayn/tools/analyze-intraday-alpha-cost-cohorts.test.ts
```

Renaming the full-report file does not change its content hash. Changing the TSV path strings or JSON formatting can change the raw full-report hash even when the source file hashes and economic records are unchanged; verify those differences explicitly. Never substitute a different source cut silently. The diagnostic records the exact input report hash and original export hashes and normalizes only displayed input basenames.

A separate Python calculation reproduced the 261 common entries, the 45/168/48 phase partition and all reported common-entry net sums. This is a calculation check, not independent economic evidence.
