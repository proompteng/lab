# Candidate ordinal 15: stock-bond-correlation regime allocation preregistration

Status: **PREREGISTERED — no development bar or holdout return has been accessed**

This document freezes the only Bayn Candidate 15 research family before any adjusted development bar, return, weight,
performance metric, benchmark comparison, bootstrap result, fold result, or gate result is queried or computed. Candidate
15 consumes one family-level attempt when its single metric-bearing development evaluation starts, regardless of whether
that evaluation passes, rejects, or terminates as `INVALID_PROTOCOL_DEVIATION`.

## Immutable base, deployed protocol, and authority boundary

- Fresh Git base: `66a973a11ed3c46a25624c324705136e8fb72233`.
- Deployed protocol/runtime source: `22dc894ad8d3223cff2bf0edb7f1c1f123c372b4`.
- Immutable deployed multi-architecture image digest:
  `sha256:32e9b7df8d40c4359d5781e3ef2efe33b410c486b47073230f7f20faaac3f8cf`.
- Argo observation before preregistration: revision
  `66a973a11ed3c46a25624c324705136e8fb72233`, `Synced`, `Healthy`, deployment `1/1` ready.
- Runtime boundary before preregistration: `BAYN_MAXIMUM_AUTHORITY=OBSERVE`, Alpaca `sandbox`, no capital promotion,
  no Candidate 15 operation, and no broker, order, database-write, manifest, GitOps, deployment, or authority mutation.
- Candidate-development implementation SHA-256 on the base:
  `e3b1b30c0deb961b1ba4a0a1a7ebcafc227e26b91d02bad9988bf85bddc70428`.
- Candidate-development schema: `bayn.candidate-development-protocol.v2`.
- Candidate ordinal: `15`.
- Prior trial count: `14`.
- Attempt binding: `candidateOrdinal = priorTrialCount + 1`.
- Maximum v2 candidate ordinal: `25`.
- Candidate 15 protocol identity hash for the frozen 126-return lookback:
  `4de2942be5edfd28618d338fb01046dd7046e0eb471d32a07ac107d5c5ed5409`.

## Prior-family audit and distinct economic hypothesis

The durable Candidate 5-14 evidence was inspected before any Candidate 15 development-return query. The consumed or
screened families are:

1. robust own-market multi-horizon trend;
2. month-end liquidity reversal;
3. raw 12-minus-1 cross-asset relative strength;
4. shrinkage minimum-variance allocation, rejected before preregistration on its then-applicable geometry;
5. asymmetric-range volatility-managed SPY exposure;
6. benchmark-anchored 52-week-high rotation;
7. abnormal-dollar-volume continuation;
8. annual same-calendar-month seasonality;
9. SPY-residual momentum;
10. 126-session relative intraday-information continuation.

Candidate 15 does not alter a window, threshold, reserve, benchmark, or allocation inside any prior family. It forecasts
neither an asset's own return nor cross-sectional winner persistence. Its sole hypothesis is that the sign of recent
stock-bond return correlation identifies whether nominal Treasury exposure is currently functioning as a deflation hedge
or sharing equity's inflation-sensitive risk. When SPY and IEF are non-positively correlated, IEF is retained as the
fixed diversifier beside SPY. When their correlation is positive, the fixed diversifier changes from IEF to DBC because
commodity futures have historically carried different business-cycle and inflation exposure from stocks and bonds.

This is materially different from Candidate 8. Candidate 8 estimated the complete cross-asset covariance matrix and
would have optimized minimum variance weights. Candidate 15 uses only the sign of one observed SPY-IEF correlation as a
macroeconomic regime classifier and then applies one of two fixed allocations. It performs no optimization, covariance
shrinkage, expected-return estimation, volatility scaling, asset ranking, or parameter selection.

Primary research motivation and caution:

- Campbell, Sunderam, and Viceira, “Inflation Bets or Deflation Hedges? The Changing Risks of Nominal Bonds,” documents
  substantial time variation and sign changes in US stock-Treasury covariance:
  <https://doi.org/10.3386/w14701>.
- Campbell, Pflueger, and Viceira, “Bond-Stock Comovements,” surveys and updates the evidence that stock-bond comovement
  changes sign across macroeconomic regimes: <https://doi.org/10.3386/w34323>.
- Gorton and Rouwenhorst, “Facts and Fantasies about Commodity Futures,” reports historically negative commodity-futures
  correlation with stocks and bonds and positive correlation with inflation and unexpected inflation:
  <https://doi.org/10.3386/w10595>.
- Fang, Liu, and Roussanov, “Getting to the Core: Inflation Risks Within and Across Asset Classes,” provides an important
  limitation: commodities primarily hedge energy inflation, not core inflation, while changing inflation exposures help
  explain stock-bond correlation: <https://doi.org/10.3386/w30169>.
- Baele, Bekaert, and Inghelbrecht, “The Determinants of Stock and Bond Return Comovements,” cautions that simple macro
  explanations do not fully account for observed comovement: <https://doi.org/10.1093/rfs/hhq014>.

These papers do not specify or validate this exact ETF rule. They motivate one small, causal, falsifiable development
specification. The observed correlation is used directly rather than inferred from an unobserved macroeconomic state.

## Frozen data, universe, and validity

- Read-only snapshot ID: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Read-only bars table: `signal.adjusted_daily_bars_v2`.
- Exact development bounds: `2016-01-04` through `2022-12-30`, inclusive.
- Untouched holdout: `2023-01-03` through `2025-12-31`, inclusive.
- Ordered universe: `DBC,EFA,IEF,SPY,VNQ`.
- Provider/feed/adjustment: Alpaca / SIP / all-adjusted daily OHLCV.
- Calendar identity: `bayn.candidate-development-calendar.v1`, `alpaca-us-equity-calendar-v1`, 1,762 sessions,
  first `2016-01-04`, last `2022-12-30`, canonical sessions hash
  `a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1`.
- Every symbol must have exactly one ordered valid bar for every official session. Missing, duplicate, unordered,
  future-dated, wrong-snapshot, wrong-symbol, non-finite, non-positive-volume, malformed-OHLC, or hash-mismatched material
  fails closed. No imputation, forward fill, alternate publication, or survivorship substitution is permitted.
- Every adjusted OHLC value must be at least `$5.00`, the frozen floor used by the analytical execution-cost envelope.
- EFA and VNQ remain required members of the complete authorized dataset identity but have frozen zero target weights.

Only the bounded calendar geometry was materialized before this preregistration. No adjusted bar was queried.

## Sole frozen feature and decision rule

Strategy name: `stock-bond-correlation-regime-allocation`.

Specification ID: `spy-ief-correlation-126-spy45-hedge45-reserve10`.

There is exactly one specification and no family selection step.

At every canonical official month-end finalized close:

1. Read exactly 127 adjusted closes ending at the signal close for SPY and IEF, producing exactly 126 aligned
   close-to-close simple daily returns for each asset.
2. Fail closed if a close or return is non-finite or non-positive, if either sample variance is not strictly positive, or
   if the aligned window is incomplete.
3. Compute ordinary Pearson sample correlation using the 126 aligned return pairs: sample covariance divided by the
   square root of the product of the two sample variances. The common `n-1` divisor is used in covariance and variance.
4. Round the finite correlation to 12 decimal places before classification and durable decision material.
5. If the rounded correlation is strictly greater than zero, select DBC as the fixed diversifier.
6. Otherwise, including an exact zero, select IEF as the fixed diversifier.
7. Target 45% SPY, 45% selected diversifier, and 10% cash. Every other symbol has target weight zero.

The rule is long-only, unlevered, has at most two positions, and has gross target exposure exactly `0.90`. It has no
return threshold, momentum or reversal filter, volume feature, trailing high, seasonality, intraday decomposition,
volatility target, covariance optimizer, stop, discretionary override, or intra-month trade. Future bars after the
finalized signal close cannot affect the decision.

Signal and rebalance occur only at canonical official month-end finalized closes. Execution occurs at the next canonical
official session open. The research simulation liquidates completely from the finalized `2022-12-29` close at the
`2022-12-30` open; every candidate and benchmark path must terminate in cash inside the development boundary.

## Analytically derived non-borrowing reserve

The 10% reserve is fixed solely from the frozen execution model, `$5.00` price floor, and finite calendar before any
development bar. It does not use any prior candidate return, observed cost, failure amount, or development metric.

- The stressed replay adds another 2.5 bps half-spread plus 2.5 bps slippage beyond the baseline cost already reflected
  in baseline quantities: 5 bps per fill. Micro accounting and `$0.0001` price quantization add less than 0.204 bps at
  the `$5.00` floor; the incremental per-side bound is conservatively rounded to 5.25 bps.
- At `$5.00`, the incremental doubled-cost TAF is at most 0.39 bps on sells, incremental SEC is 0.206 bps on sells, and
  incremental CAT is at most 0.006 bps per side. Caps and deterministic partial fills only reduce this envelope.
- Existing long positions can represent at most 100% of marked equity and new buys target at most 90%. A complete
  sell-and-buy transition is bounded by
  `1.00 * (5.25 + 0.39 + 0.206) + 0.90 * 5.25 + 1.90 * 0.006 = 10.5824` basis points,
  plus at most three `$0.01` fee-rounding increments.
- The frozen calendar permits at most 77 eligible monthly executions plus terminal liquidation. Treating all 78 as
  complete sell-and-buy transitions gives `78 * 10.5824 = 825.4272` basis points and at most `$2.34` of aggregate fee
  rounding.
- The 10% reserve exceeds the finite-schedule 8.254272% normalized incremental-cost envelope. The exact causal replay
  must still prove non-negative cash on every session; this analytical bound never waives the fail-closed check.

## Shared simulation and exact doubled-cost causal path

- Initial simulated capital: `1000000000000` micros ($1,000,000).
- The existing shared simulation and `defaultExecutionModel` are authoritative.
- Ordinary non-extended `DAY` market orders are planned after the finalized signal close and filled from the next
  session open. Planned sell proceeds cannot fund same-session buys.
- Baseline half-spread is 2.5 bps and baseline slippage is 2.5 bps. Commission is zero. SEC, TAF, and CAT fees use
  `alpaca-brokerage-2026-07-01`. Quantity and price accounting use the shared integer-micros implementation.
- Deterministic partial fills remain unchanged. No post-result fill, price, cost, or affordability change is allowed.
- Baseline cost multiplier: `1000000` micros (`1x`).
- Stressed cost multiplier: `2000000` micros (`2x`).

The baseline run uses the shared simulator with evidence recording. The stressed run is a candidate-local causal replay
of the baseline's exact ordered signal decisions and exact ordered requested and filled order quantities. It reuses the
shared execution model and shared fill, fee, cash-yield, valuation, and performance functions at exactly `2x`; it
recomputes prices, spread, slippage, fees, cash, positions, marks, returns, and metrics without generating new
quantities.

The stressed replay must remain long-only and must never borrow. A missing trace, malformed evidence, negative cash, an
unapplicable baseline order, changed execution model, changed signal decision, or changed ordered requested/filled
quantity path is terminal `INVALID_PROTOCOL_DEVIATION`. Candidate-development v2 must verify invariant canonical hashes
for signals, quantities, and execution model before any report is accepted.

## Frozen v2 geometry, multiplicity, and statistics

The pure v2 preflight passed before preregistration with no market-data I/O:

- feature lookback declaration: 126 return sessions;
- first eligible signal: `2016-07-29` at index 144;
- first next-session execution: `2016-08-01` at index 145;
- available observations after first execution: 1,617;
- selected latest-contiguous observations: 1,489, indices 273 through 1,761, `2017-02-02` through `2022-12-30`;
- unused earlier eligible observations: 128;
- initial training observations: 504;
- five chronological, non-overlapping 197-observation test folds;
- fold test intervals: `2019-02-05..2019-11-13`, `2019-11-14..2020-08-26`,
  `2020-08-27..2021-06-09`, `2021-06-10..2022-03-21`, and `2022-03-22..2022-12-30`;
- family specification multiplicity: 1;
- prior family attempts: 14;
- candidate-adjusted one-sided alpha: `0.05 / 15 = 0.0033333333333333335`;
- paired complete-rebalance-block bootstrap samples: exactly 10,000;
- nearest-rank adjusted lower-tail sample count: 33;
- minimum permitted tail samples: 20;
- no alternate seed, sample count, block construction, fold boundary, alpha interpretation, or family correction.

The shared power policy requires at least 69 complete non-wrapping rebalance blocks and 1,449 complete sessions for its
3% annualized excess-return effect at 10% tracking volatility, subject also to the absolute floors of 24 blocks and 504
sessions.

## Complete prior-attempt lineage

The analysis must verify and use these fourteen canonically sorted family-attempt identities, including Candidate 14's
valid family run `cc3ec71d86e90308697c7ca58598d0b7cef50553fcc9d4576159da6c42e7b066`:

1. `300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47`
2. `36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c`
3. `440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861`
4. `70763f839afd9359a34ea70dd833bf7a6fb1553aad98921b8f25282851fcf773`
5. `7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32`
6. `87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f`
7. `8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be`
8. `8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc`
9. `9c495c857a67659a56ca9381ff03d6839cf1812abbf70c73bc75de372bcaf118`
10. `a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217`
11. `b38d784ce8124bbbff7513a9f8c94ec6ac4d51d7c01bf5c369bcfe3bc5aa2183`
12. `b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7`
13. `bf19a5d8b29032146effeadca2bf129924c9062dd5b516a0483927207c333cfc`
14. `cc3ec71d86e90308697c7ca58598d0b7cef50553fcc9d4576159da6c42e7b066`

The fourth identity records Candidate 13's consumed protocol-deviation outcome because no conforming family run was
emitted. The eleventh records Candidate 12's consumed protocol-invalid family attempt. The list is an attempt lineage,
not a claim that invalid attempts produced valid economic evidence.

## Mechanical benchmarks and every development gate

The candidate is compared on the exact same selected observations against:

1. SPY buy-and-hold, using causal next-open entry, shared costs, and terminal next-open liquidation; and
2. the existing causal direct SPY 10%-annualized-volatility timing benchmark, rebalanced on Candidate 15's schedule,
   using the same next-session opens, shared costs, and terminal liquidation.

The stronger benchmark is whichever has greater point Sharpe. An exact tie selects SPY buy-and-hold. This mechanical
selection occurs before benchmark-relative point and uncertainty gates and cannot change after results.

Candidate 15 development status is `PASS` only if every requirement below passes:

- the v2 preregistration, attempt, calendar, protocol hash, dataset shape, bounded content hashes, and one-shot contract;
- at least 504 aligned strategy observations;
- positive strategy annualized net return;
- strategy point Sharpe strictly greater than the mechanically stronger benchmark point Sharpe;
- maximum drawdown no greater than 35%;
- annual turnover no greater than 12;
- positive annualized return under the conforming invariant-signal/invariant-quantity `2x` cost replay;
- adjusted annualized excess-return lower confidence bound strictly greater than zero;
- adjusted Sharpe-difference lower confidence bound strictly greater than zero;
- at least 69 complete non-wrapping rebalance blocks and 1,449 complete sessions;
- at least three of five walk-forward folds with positive benchmark excess return;
- every fold drawdown no greater than 35%; and
- complete terminal cash in baseline candidate, stressed candidate, SPY buy-and-hold, and direct-volatility paths.

There is no weighted score, near-pass, economic override, alternate benchmark, post-result gate reinterpretation, or
family substitution.

## Exact one-shot rule and authorized outcomes

After this file is committed, candidate-specific source, tests, and CLI may be implemented. All decision and replay
behavior must first be proven on synthetic fixtures. The evaluated implementation commit and this immutable
preregistration commit and SHA-256 must be fixed before the first adjusted development-bar query. V2 preflight must pass
again inside the command before I/O.

Exactly one metric-bearing development evaluation is authorized over `2016-01-04` through `2022-12-30`.

- A transport or query-schema failure before any return or metric is produced may be repaired only without changing a
  preregistration byte, strategy behavior, parameter, data request, cost, benchmark, seed, fold, gate, or evaluated
  identity.
- Once any development return, performance metric, fold, bootstrap value, confidence bound, or gate result exists,
  Candidate 15 is consumed and cannot be rerun, retuned, reseeded, repaired, substituted, or reframed.
- A conforming failure of any gate is `HOLD_REJECT`.
- Signal or quantity divergence, borrowing in the invariant replay, or another breach of these bytes is
  `INVALID_PROTOCOL_DEVIATION`.
- Either terminal non-pass requires executable Candidate 15 code, tests, CLI, and package wiring to be removed from the
  final branch while preserving this preregistration, the evaluated commit, and honest human-readable Markdown evidence
  in ancestry. The evidence PR must close unmerged.
- Only a complete development `PASS` may retain the minimal source and evidence in a reviewed ready PR. Even then,
  holdout access, terminal qualification, merge, deployment, PAPER or LIVE authority, capital, and orders require a
  separate explicit user authorization and are not granted here.

No JSON evidence dump may be committed.

## Holdout and mutation attestation

The holdout remains exactly:

```text
start=2023-01-03
end=2025-12-31
inspected=false
accessCount=0
```

No query may mention or span a holdout date. Candidate 15 authorizes no broker mutation, order submission, capital grant,
database write, runtime composition change, manifest edit, GitOps change, deployment, PAPER/LIVE authority, or production
strategy replacement. Development evidence is research evidence only and is not a profitability claim.
