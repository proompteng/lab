# Candidate 19: inverse-volatility risk diversification

This document immutably preregisters exactly one Candidate 19 development-only attempt. It contains no development metrics, qualification evidence, holdout access, broker authority, PAPER authority, capital authority, or profitability claim.

## Trial lineage

- Candidate ordinal: `19`.
- Prior trial count used by all multiplicity and selection-bias controls: `18`.
- Qualification ordinals remain exactly `1..16`.
- Candidate 16 remains terminal `HOLD_REJECT`, with source revision `60a48a2e52fbafdd67a404a33a3cb22e82a98493` and preregistration blob `f602e3c8fd1b85768404d5fbc439775cdcd2570b`.
- Candidate 17 remains terminal `DEVELOPMENT_REJECTED`, with evidence content hash `97b9c2d6dc1d59d9b60686065bc4d595b8d1f22cdff9930b6131427b90e13f26`, and consumed no qualification attempt.
- Candidate 18 remains terminal `DEVELOPMENT_REJECTED` after one `buildEvaluation-preflight` failure, with evidence content hash `65d6f044f3f323aa87ff26a3dca011053aa3172c8a4ce422841497ccf370a5b6`, `developmentMetricsObserved=false`, and no qualification attempt consumed.
- Complete canonical v2 prior-trials hash, including Candidate 16 qualification lineage and Candidate 17/18 development evidence: `1dfc9b6832d4841093becd2c276141110afdfce28a0a88b301cfe9959b900d62`.
- Candidate 20 is not authorized.

## Primary-source basis

The family uses ex-ante risk estimates and long-only constraints without fitting any parameter to Bayn development results:

1. Harry Markowitz, _Portfolio Selection_, DOI `10.1111/j.1540-6261.1952.tb01525.x`, https://doi.org/10.1111/j.1540-6261.1952.tb01525.x
2. Thierry Roncalli, Sébastien Maillard, and Jérôme Teïletche, _The Properties of Equally Weighted Risk Contribution Portfolios_, DOI `10.3905/jpm.2010.36.4.060`, https://doi.org/10.3905/jpm.2010.36.4.060
3. Ravi Jagannathan and Tongshu Ma, _Risk Reduction in Large Portfolios: Why Imposing the Wrong Constraints Helps_, DOI `10.1111/1540-6261.00580`, https://doi.org/10.1111/1540-6261.00580

The fixed 63-session lookback is one trading quarter. The fixed 10% annualized target is the already-governed direct-volatility benchmark target. No alternate lookback, target, covariance estimator, universe, weight cap, gross-exposure cap, signal filter, or fallback may be tried after any development metric is observed.

## Result-blind strategy specification

At each finalized official month-end close:

1. Use exactly the prior 63 daily adjusted-close returns for `SPY` and `DBC`.
2. Estimate each asset's sample annualized volatility using 252 sessions per year and estimate their sample annualized covariance from the same causal window.
3. Set each asset's unscaled long-only weight proportional to the inverse of its strictly positive annualized volatility; normalize the two weights to sum to one.
4. Compute the normalized portfolio's annualized covariance risk and scale both weights by `min(1, 0.10 / estimatedPortfolioVolatility)`.
5. Hold the unallocated fraction as cash. Gross exposure is capped at 100%; leverage and shorting are prohibited.
6. Execute at the next official session open. Missing, malformed, stale, noncausal, zero-volatility, or nonfinite data fails closed without imputation.
7. The `2022-11-30` signal liquidates at the `2022-12-01` open and remains cash through the terminal observation.

`EFA`, `IEF`, and `VNQ` remain in the exact finalized market-data witness but always receive zero strategy weight. Candidate 19 uses neither trend nor relative/absolute momentum and is economically distinct from Candidate 17 volatility-managed trend and Candidate 18 global-equity dual momentum.

Canonical strategy-identity hash: `ccf8f03db1f0f9eb54f7ad42194c938e5a53e11573488fd31e7af871967af25a`.

## Frozen development protocol

- Strategy protocol hash: `b4a2a6c65a7fa5973f7cbc1fd5031e77d529f4884562e5cc8a105fc870ced78f`.
- Candidate-development protocol hash: `663b59d6c570bbe3373d6e160609e0ad6294a687f435416f2a0956888d960738`.
- Calendar: Alpaca US-equity calendar v1, `2016-01-04..2022-12-30`, exactly 1,762 sessions, canonical hash `4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237`.
- First causal execution after the 63-session feature window: signal `2016-04-29`, execution `2016-05-02`.
- Selected governed observation window: `2017-02-02..2022-12-30`, 1,489 sessions, five unchanged expanding-origin folds.
- Market snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Finalized snapshot content hash: `8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d`.
- Input manifest hash: `b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4`.
- Bounded development content hash: `e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed`.
- Benchmark policy: SPY buy-and-hold and the unchanged 63-session direct-volatility-timing comparator, with terminal comparison at the last all-cash strategy decision.
- Statistics and selection controls remain unchanged: 10,000 paired complete-rebalance-block bootstrap samples, Bonferroni one-sided alpha `0.05 / 19`, minimum 20 lower-tail samples, unchanged power assumptions, five expanding-origin walk-forward folds, at least 60% positive folds, 35% maximum fold drawdown, positive annualized excess-return and Sharpe-difference lower bounds, positive doubled-cost return, economic verdict, and exact baseline/stressed terminal cash.
- Execution and cost model remains unchanged: next-session-open market fills, 2.5 bps half spread, 2.5 bps slippage, unchanged SEC/TAF/CAT fees, deterministic partial fills, zero cash yield, and exact doubled-cost replay on the same signal and ordered requested/filled quantity path.

## Executable and source-manifest binding

- Module path: `services/bayn/src/strategy/inverse-volatility-risk-diversification/candidate-19.ts`.
- Precommitted module SHA-256: `90813ab3a3d3cb000bb894309694f94588f98730a6f78b8e1418a5c38d8cb45f`.
- Source-manifest path: `services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-source-manifest.json`.
- Module format: self-contained ESM with no imports.

The executable blob must first appear in a proper descendant of this preregistration commit and must match the precommitted SHA-256 exactly. Before any metric-bearing evaluation, the generic command guard must independently match artifact ordinal, prior-trial count, strategy protocol hash, strategy identity hash, candidate-development protocol hash, calendar hash, complete v2 prior-trials hash, module path/blob/SHA-256, source-manifest path/blob/SHA-256, and every manifest binding. Repository grafts, replacement objects, alternates, shallow history, stale evidence, tampered bindings, or any pre-existing executable blob fail closed before evaluation.

Exactly one metric-bearing Candidate 19 development evaluation is authorized only after this preregistration and its descendant immutable source are committed and reviewed. A rejection must record `DEVELOPMENT_REJECTED`, consume no qualification attempt, and leave the next preregistration null. A pass may commit only fully bound development evidence and must not execute qualification or enable trading.
