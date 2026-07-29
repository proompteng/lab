# Candidate ordinal 13: SPY-residual momentum rotation preregistration

Status: **PREREGISTERED — development returns and the 2023-2025 holdout have not been inspected**

This document freezes the only Candidate 13 research family before any query of development bars or any return-bearing
metric. Candidate 13 is one consumed family-level attempt regardless of whether its one evaluation passes, rejects, or
is classified `INVALID_PROTOCOL_DEVIATION`.

## Immutable lineage and attempt binding

- Fresh base commit: `e0d6f23814df4749f6c9432d6b53d5f8c9e00f80`.
- Candidate-development v2 source revision on that base: `ad9a7477d645b4644c83384158783b2083fc7f88`.
- Deployed protocol image observed before preregistration:
  `sha256:ad8c84a312bcf66cc998029b91f13e4e785f50e30351396e69a1b0f68183e881`.
- Candidate ordinal: `13`.
- Prior trial count: `12`.
- Attempt rule: `candidateOrdinal = priorTrialCount + 1`; no alias, replacement ordinal, or post-result reset is allowed.
- Candidate 13 protocol identity hash for a 252-session feature lookback:
  `e9cc365a8b1c2cffe2aa37b496387000695e2a78d1093ad36e142261eab88454`.
- Protocol schema: `bayn.candidate-development-protocol.v2`.
- Calendar schema and identity: `bayn.candidate-development-calendar.v1`, 1,762 sessions,
  `2016-01-04` through `2022-12-30`, sessions hash
  `a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1`.

The twelve preceding family-attempt identities are frozen as:

1. `300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47`
2. `36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c`
3. `440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861`
4. `7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32`
5. `87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f`
6. `8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be`
7. `8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc`
8. `9c495c857a67659a56ca9381ff03d6839cf1812abbf70c73bc75de372bcaf118`
9. `a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217`
10. `b38d784ce8124bbbff7513a9f8c94ec6ac4d51d7c01bf5c369bcfe3bc5aa2183`
11. `b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7`
12. `bf19a5d8b29032146effeadca2bf129924c9062dd5b516a0483927207c333cfc`

The tenth identity in this sorted list is Candidate 12's consumed protocol-invalid family run. Its inclusion records the
attempt without treating its nonconforming doubled-cost output as valid evidence.

## Prior-family audit and distinct hypothesis

Candidates 5 through 12 consumed or ruled out robust own-market trend, month-end liquidity reversal, raw cross-asset
relative strength, shrinkage minimum variance, asymmetric-range volatility management, benchmark-anchored 52-week-high
rotation, abnormal-volume continuation, and annual same-calendar-month seasonality. Candidate 13 does not change a
parameter in any of those rules and does not reuse their observed development results.

The sole hypothesis is that the idiosyncratic component of intermediate-horizon return persists more reliably than raw
total return because common SPY exposure can reverse independently of asset-specific information. The primary research
motivation is Blitz, Huij, and Martens, “Residual Momentum,” _Journal of Empirical Finance_ 18(3), 2011,
DOI `10.1016/j.jempfin.2011.01.003`. That paper ranks stocks on factor-residualized 12-minus-1 returns standardized by
residual volatility and reports lower common-factor exposure than conventional total-return momentum.

Candidate 13 is a constrained ETF adaptation, not a reproduction of the paper: the frozen universe has only five ETFs,
SPY is the only available common factor, the maximum causal lookback is 252 sessions, and short positions are forbidden.
No claim is made that the published stock-level result validates this exact ETF rule.

## Frozen data and universe

- Read-only snapshot ID: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Sessions table: `signal.exchange_sessions_v1`.
- Bars table: `signal.adjusted_daily_bars_v2`.
- Development bounds: `2016-01-04` through `2022-12-30`, inclusive.
- Exact ordered universe: `DBC,EFA,IEF,SPY,VNQ`.
- Required fields: all-adjusted daily open, high, low, close, and volume.
- Required shape: one unique, valid bar for every symbol and every one of the 1,762 official sessions; no imputation,
  forward fill, alternate publication, mixed snapshot, or missing-row tolerance.
- Data identity is bound by canonical hashes of the ordered official sessions and the ordered `(session,symbol,OHLCV)`
  bars before evaluation.
- The evaluator may first materialize and verify only the bounded official calendar. The first return-bearing query is
  forbidden until this preregistration is committed and its bytes are SHA-256 bound by the implementation.

## Sole frozen specification

Strategy name: `spy-residual-momentum-rotation`.

Specification ID: `spy-residual-231-skip21-core49_5-active49_5`.

There is exactly one specification and no parameter selection step.

### Feature

At every official month-end finalized close:

1. Use exactly 253 adjusted closes ending on the signal session, producing 252 close-to-close simple daily returns.
2. For each challenger in `DBC,EFA,IEF,VNQ`, estimate one ordinary least-squares regression with an intercept over all
   252 paired daily returns:

   `challengerReturn = alpha + beta * spyReturn + error`.

3. Fail closed if any return is non-finite, SPY return variance is not strictly positive, or the regression is otherwise
   undefined.
4. Define each daily factor-residualized return as `challengerReturn - beta * spyReturn`. The estimated intercept is not
   subtracted from the ranking return, matching the research choice not to include estimated alpha in residual momentum.
5. The formation segment is the first 231 residualized returns. The most recent 21 returns are excluded from the score
   to separate intermediate-horizon continuation from short-run reversal.
6. The score is `mean(formation residualized returns) / sampleStandardDeviation(formation residualized returns)`.
   Fail closed if the sample standard deviation is not strictly positive or the score is non-finite.
7. A challenger is eligible only when its score is strictly greater than zero.
8. Select the eligible challenger with the greatest score; an exact score tie is broken by ascending symbol. If none is
   eligible, select no challenger and use the SPY fallback.

All arithmetic uses JavaScript finite numbers and the final feature components are rounded to 12 decimal places before
they enter the durable decision material. Future bars after the finalized signal close cannot affect a decision.

### Allocation and schedule

- Eligible challenger: target `49.5%` SPY, `49.5%` selected challenger, and `1%` cash.
- No eligible challenger: target `99%` SPY and `1%` cash.
- Every unselected symbol has target weight zero.
- Long-only, unlevered, maximum two positions, gross target exposure exactly `0.99`.
- The 1% cash reserve is frozen protocol mechanics for an unborrowed invariant-quantity doubled-cost replay; it is not a
  tunable signal parameter.
- Signal: every canonical official month-end finalized close.
- Execution: the next canonical official session open.
- Terminal liquidation signal: finalized close `2022-12-29`.
- Terminal liquidation execution: open `2022-12-30`; all target weights are zero.

## Simulation and costs

- Initial capital: `1000000000000` micros ($1,000,000).
- Shared simulation and `defaultExecutionModel` are authoritative.
- Market order, day time-in-force, regular session only, planned from signal close and filled from next-session open.
- Half-spread: 2.5 basis points; slippage: 2.5 basis points; current deterministic SEC, TAF, and CAT fee schedule;
  deterministic partial-fill contract; no sell-proceeds funding of same-session buys.
- Baseline cost multiplier: `1000000` micros (`1x`).
- Stressed cost multiplier: `2000000` micros (`2x`).
- No cost waiver, cost estimate substitution, or post-result execution-model change is permitted.

### Doubled-cost v2 causal path

The baseline run uses the shared simulator with event recording. The stressed run is a candidate-local causal replay of
the baseline's exact ordered signal decisions and exact ordered requested/filled order quantities. It reuses the shared
execution model and shared fill/fee/cash-yield cost functions at exactly `2x`; it recomputes fill prices, spread,
slippage, fees, cash, positions, daily marks, daily returns, and performance without generating new quantities.

The replay must remain long-only and must never borrow: negative cash, an absent baseline trace, malformed evidence, or
an inability to apply an exact baseline order fails closed. Before any report can be returned,
`runCandidateDevelopment` must verify identical canonical hashes for baseline and stressed signal decisions, ordered
requested/filled quantity paths, and execution models. Any difference is terminal
`INVALID_PROTOCOL_DEVIATION`, consumes Candidate 13, and authorizes no rerun.

## Development geometry and multiplicity

- Feature lookback declaration: 252 sessions.
- First eligible signal: `2017-01-31`; first next-session execution: `2017-02-01`.
- End-anchored comparison window: 1,489 observations, `2017-02-02` through `2022-12-30`.
- Initial training observations: 504.
- Five chronological non-overlapping test folds of 197 observations each.
- One eligible observation is deliberately unused before the selected end-anchored window.
- Family specification multiplicity: 1.
- Prior family attempts: 12.
- Candidate-adjusted one-sided alpha: `0.05 / 13 = 0.0038461538461538464`.
- Paired complete-rebalance-block bootstrap samples: 10,000.
- Nearest-rank adjusted lower-tail sample count: 38; minimum permitted tail samples: 20.
- Bootstrap seed namespace and every other shared statistic remain exactly those in the candidate-development v2 policy.
- No alternate seed, sample count, block construction, fold boundary, or alpha interpretation is permitted.

## Stronger benchmark and gates

The strategy is compared on the exact same 1,489 sessions against:

1. SPY buy-and-hold, next-open entry and terminal next-open liquidation under the same execution costs; and
2. the existing causal direct SPY 10% volatility-timing benchmark, rebalanced on the strategy schedule and executed at
   the same next-session opens.

For benchmark-relative point metrics and uncertainty, the stronger benchmark is whichever has the greater point Sharpe;
an exact tie selects SPY buy-and-hold. This choice is mechanical and cannot be changed after observing results.

Every gate below must pass for Candidate 13 development status `PASS`:

- at least 504 strategy observations;
- positive strategy annualized return;
- strategy point Sharpe strictly greater than the stronger benchmark point Sharpe;
- maximum drawdown no greater than 35%;
- annual turnover no greater than 12;
- positive annualized return under the conforming invariant-path `2x` cost replay;
- adjusted annualized excess-return lower confidence bound strictly greater than zero;
- adjusted Sharpe-difference lower confidence bound strictly greater than zero;
- sufficient complete non-wrapping rebalance blocks and sessions under the shared power policy;
- at least three of five walk-forward folds with positive excess return;
- every walk-forward fold drawdown no greater than 35%; and
- complete terminal liquidation to cash in baseline, stressed, SPY buy-and-hold, and direct-volatility simulations.

No weighted score, near-pass, economic override, alternate benchmark, or post-result gate reinterpretation exists.

## Exact one-shot rule and authorized outcomes

After this file is committed, candidate-specific code may be implemented and tested only with synthetic fixtures. The
evaluated implementation commit and the preregistration commit/hash must be fixed before the first development-bar query.
Preflight must pass before I/O. Then exactly one metric-bearing development evaluation may query the frozen development
snapshot and run the sole specification.

- A transport failure before any metric is produced may be repaired without changing these bytes, the evaluated
  behavior, the data request, or the frozen identities.
- Once any development return, performance metric, fold result, bootstrap result, or gate result is produced, Candidate
  13 is consumed. It may not be rerun, retuned, reseeded, repaired, substituted, or reframed.
- A valid failure of any gate is `HOLD_REJECT`.
- Any signal or quantity-path divergence, or another violation of these bytes, is `INVALID_PROTOCOL_DEVIATION`.
- Either terminal non-pass outcome requires removal of executable Candidate 13 code from the final branch, retention of
  human-readable Markdown evidence only, and closure of the PR unmerged.
- Only a complete development `PASS` may retain the minimal executable code in a reviewed ready PR. Even then, holdout
  access and terminal qualification require separate user authority and are not authorized here.

## Holdout and mutation boundary

The holdout is exactly `2023-01-03` through `2025-12-31`. It remains:

```text
inspected=false
accessCount=0
```

No query may mention or span a holdout date. Candidate 13 authorizes no terminal qualification, broker read or write,
database write, capital grant, runtime or manifest mutation, GitOps change, deployment, PAPER/LIVE authority, or order
submission. Development evidence is research evidence only and is not a profitability claim.
