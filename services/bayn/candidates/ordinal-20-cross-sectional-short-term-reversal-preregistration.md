# Candidate 20: cross-sectional short-term reversal

This document immutably preregisters exactly one result-blind Candidate 20 for a separately authorized governed evaluation. It authorizes zero metric-bearing attempts in this change and contains no development metrics, qualification evidence, holdout access, broker authority, PAPER authority, capital authority, or profitability claim.

## Trial lineage

- Candidate ordinal: `20`.
- Prior trial count used by all multiplicity and selection-bias controls: `19`.
- Qualification ordinals remain exactly `1..16`.
- Candidate 16 remains terminal `HOLD_REJECT`, with source revision `60a48a2e52fbafdd67a404a33a3cb22e82a98493` and preregistration blob `f602e3c8fd1b85768404d5fbc439775cdcd2570b`.
- Candidate 17 remains terminal `DEVELOPMENT_REJECTED`, with evidence content hash `97b9c2d6dc1d59d9b60686065bc4d595b8d1f22cdff9930b6131427b90e13f26`, and consumed no qualification attempt.
- Candidate 18 remains terminal `DEVELOPMENT_REJECTED` after one `buildEvaluation-preflight` failure, with evidence content hash `65d6f044f3f323aa87ff26a3dca011053aa3172c8a4ce422841497ccf370a5b6`, `developmentMetricsObserved=false`, and no qualification attempt consumed.
- Candidate 19 remains terminal `DEVELOPMENT_REJECTED` after exactly one development-only metric-bearing attempt, with evidence content hash `6170af41ddc14c04412a1929a60c88f35062ec2440f6e4b3beb0539bd411f364`, `developmentMetricsObserved=true`, `qualificationAttemptConsumed=false`, and no rerun.
- Complete canonical v2 prior-trials hash, including Candidate 16 qualification lineage and Candidate 17/18/19 development evidence: `dfda4c7706cdd7b2999a863ac63714c5d46894027442253f031b69bcdeaefde0`.
- Candidate 20 has zero development attempts and zero qualification attempts in this precommit.
- Candidate 21 is not authorized.

## Primary-source basis

The family is a precommitted, falsifiable extrapolation of documented short-horizon return reversal. No parameter was selected from Bayn development, qualification, holdout, or profitability results:

1. Narasimhan Jegadeesh, _Evidence of Predictable Behavior of Security Returns_, DOI `10.1111/j.1540-6261.1990.tb05110.x`, https://doi.org/10.1111/j.1540-6261.1990.tb05110.x
2. Bruce N. Lehmann, _Fads, Martingales, and Market Efficiency_, DOI `10.2307/2937816`, https://doi.org/10.2307/2937816
3. Andrew W. Lo and A. Craig MacKinlay, _When Are Contrarian Profits Due to Stock Market Overreaction?_, DOI `10.1093/rfs/3.2.175`, https://doi.org/10.1093/rfs/3.2.175
The classic evidence concerns individual securities and shorter horizons. Applying a fixed 21-session loser rule to the frozen cross-asset ETF witness is therefore explicitly an unvalidated hypothesis, not a claimed replication. The 21-session horizon is one trading month; the fixed two-selection limit and 50% per-selection weight bound gross exposure without fitting covariance or volatility. No alternate horizon, rank rule, sign gate, selection count, weight, universe, fallback, or tie-break may be tried after any development metric is observed.

## Result-blind strategy specification

At each finalized official month-end close:

1. Use exactly 22 adjusted closes to calculate each witness asset's causal 21-session total return for `DBC`, `EFA`, `IEF`, `SPY`, and `VNQ`.
2. Rank all five assets by ascending total return. Break exact return ties by ascending symbol, independent of input order or locale.
3. Keep only assets with strictly negative total return and select at most the first two ranked assets.
4. Assign exactly 50% weight to each selected asset. One selected asset therefore leaves 50% in cash; no selected assets leaves 100% in cash.
5. Use no positive-momentum filter, trend score, volatility target, covariance estimate, inverse-volatility weight, leverage, or short position.
6. Execute at the next official session open. Missing, malformed, stale, noncausal, or nonfinite data fails closed without imputation.
7. The `2022-11-30` signal liquidates at the `2022-12-01` open and remains cash through the terminal observation.

This behavior is not reachable from prior executable candidate history. Candidate 17 applies positive trend with volatility management; Candidate 18 selects relative and absolute momentum winners; Candidate 19 ignores return ranking and allocates by inverse volatility. Candidate 20 instead selects strictly negative-return losers with fixed weights and no risk-estimate weighting.

The closed command schema is not broadened. Candidate 20 uses only the established `bayn.candidate-development-strategy-identity.v2` fields. Its historical `family` discriminator and the structured covariance/target-volatility compatibility fields are non-operative wire metadata; the candidate-specific identifier, weighting, risk-scaling description, protocol hash, and executable planner bind the materially distinct reversal behavior.

Canonical strategy-identity hash: `8c99589120d8f3ed36c5286ce119d20490d42becd014e7fc2cc97b1420600278`.

## Frozen development protocol

- Strategy protocol hash: `18b61d027e2235c7fc8ba718313ae8863650c2cb7c497dc4a7a5028829d19e0f`.
- Candidate-development protocol hash: `f7d4d78e70401c01c141fc7b63c4c1cfe9e7350b973c40ffbd7d8fe9832b332f`.
- Calendar: Alpaca US-equity calendar v1, `2016-01-04..2022-12-30`, exactly 1,762 sessions, canonical hash `4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237`.
- First causal execution after the 21-session feature window: signal `2016-02-29`, execution `2016-03-01`.
- Selected governed observation window: `2017-02-02..2022-12-30`, 1,489 sessions, five unchanged expanding-origin folds.
- Market snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Finalized snapshot content hash: `8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d`.
- Input manifest hash: `b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4`.
- Bounded development content hash: `e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed`.
- Benchmark policy remains SPY buy-and-hold and the unchanged 63-session direct-volatility-timing comparator, with terminal comparison at the last all-cash strategy decision.
- Statistics and selection controls remain unchanged: 10,000 paired complete-rebalance-block bootstrap samples, Bonferroni one-sided alpha `0.05 / 20`, minimum 20 lower-tail samples, unchanged power assumptions, five expanding-origin walk-forward folds, at least 60% positive folds, 35% maximum fold drawdown, positive annualized excess-return and Sharpe-difference lower bounds, positive doubled-cost return, economic verdict, and exact baseline/stressed terminal cash.
- Execution and cost model remains unchanged: next-session-open market fills, 2.5 bps half spread, 2.5 bps slippage, unchanged SEC/TAF/CAT fees, deterministic partial fills, zero cash yield, and exact doubled-cost replay on the same signal and ordered requested/filled quantity path.

## Executable and source-manifest binding

- Module path: `services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts`.
- Precommitted module SHA-256: `15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441`.
- Source-manifest path: `services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json`.
- Module format: self-contained ESM with no imports.

The executable blob must first appear in a proper descendant of this preregistration commit and must match the precommitted SHA-256 exactly. Before any separately authorized metric-bearing evaluation, the generic command guard must independently match artifact ordinal, prior-trial count, strategy protocol hash, strategy identity hash, candidate-development protocol hash, calendar hash, complete v2 prior-trials hash, module path/blob/SHA-256, source-manifest path/blob/SHA-256, and every manifest binding. Repository grafts, replacement objects, alternates, shallow history, stale evidence, tampered bindings, or any pre-existing executable blob fail closed before evaluation.

This task ends at an immutable reviewed precommit. It does not authorize running Candidate 20, consuming a qualification attempt, creating Candidate 21, or enabling trading.
