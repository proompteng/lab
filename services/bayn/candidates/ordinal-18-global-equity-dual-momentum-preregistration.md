# Candidate 18: global-equity dual momentum

This document immutably preregisters exactly one Candidate 18 development attempt. It contains no development metrics, qualification evidence, holdout access, broker authority, or profitability claim.

## Trial lineage

- Candidate ordinal: `18`.
- Prior trial count used by all selection-bias controls: `17`.
- Qualification ordinals remain exactly `1..16`.
- Candidate 17 remains terminal `DEVELOPMENT_REJECTED`, with evidence content hash `97b9c2d6dc1d59d9b60686065bc4d595b8d1f22cdff9930b6131427b90e13f26`, and consumed no qualification attempt.
- Canonical prior-trials hash: `58f4e801380f35f483f998e00c82889e0cb6257e85542764e2dc8eaa4f3fd419`.
- Candidate 19 is not authorized.

## Primary-source basis

The family combines relative and absolute momentum without fitting any parameter to Bayn development results:

1. Gary Antonacci, *Risk Premia Harvesting Through Dual Momentum*, SSRN 2042750, DOI `10.2139/ssrn.2042750`.
2. Tobias J. Moskowitz, Yao Hua Ooi, and Lasse Heje Pedersen, *Time Series Momentum*, DOI `10.1016/j.jfineco.2011.11.003`.
3. Clifford S. Asness, Tobias J. Moskowitz, and Lasse Heje Pedersen, *Value and Momentum Everywhere*, DOI `10.1111/jofi.12021`.

The fixed 252-session horizon represents one trading year and the literature-standard 12-month momentum horizon. No alternate horizon, skip month, threshold, universe, rank rule, weight, volatility target, or fallback may be tried after development metrics are observed.

## Result-blind strategy specification

At each finalized official month-end close:

1. Calculate split/dividend-adjusted 252-session total returns for `SPY`, `EFA`, and `IEF` using only data available through that close.
2. Select the higher-return risk asset between `SPY` and `EFA`; exact ties select `SPY`.
3. If the selected risk asset has strictly positive return, target 100% of that asset.
4. Otherwise, target 100% `IEF` only when `IEF` has strictly positive return.
5. Otherwise, target 100% cash.
6. Execute at the next official session open. Missing, malformed, stale, or noncausal data fails closed without imputation.
7. The `2022-11-30` signal liquidates at the `2022-12-01` open and remains cash through the terminal observation.

`DBC` and `VNQ` remain in the frozen market-data universe to preserve the exact snapshot and benchmark witness, but Candidate 18 never allocates to them. Candidate 18 has no fixed SPY core, active basket, volatility targeting, parameter search, leverage, or shorting and is therefore economically distinct from Candidate 17.

Canonical strategy-identity hash: `ff762a985c129055670224dca5827a65c689f6f50e1e3765e7b521a05417b1f0`.

## Frozen development protocol

- Strategy protocol hash: `7e27320b47cd170c1bc9c60ec3692593f2182af44bb48cef4d4a403b09601d75`.
- Candidate-development protocol hash: `46657425873b4f766b5f49d0ebbe2ac3aa9cf53682a8508635be708406271877`.
- Calendar: Alpaca US-equity calendar v1, `2016-01-04..2022-12-30`, exactly 1,762 sessions, canonical calendar hash `4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237`.
- Market snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Finalized snapshot content hash: `8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d`.
- Input manifest hash: `b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4`.
- Bounded development content hash: `e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed`.
- Benchmark policy: SPY buy-and-hold and the unchanged 63-session direct-volatility-timing comparator, with terminal comparison at the last all-cash strategy decision.
- Existing unchanged gates: power, bootstrap tail resolution, annualized excess-return lower bound above zero, Sharpe-difference lower bound above zero, five walk-forward folds with at least 60% positive, maximum fold drawdown 35%, positive doubled-cost return, economic verdict, and exact baseline/stressed terminal cash.
- Existing execution/cost model: next-session-open market fills, 2.5 bps half spread, 2.5 bps slippage, unchanged SEC/TAF/CAT fees, deterministic partial fills, zero cash yield, and an exact doubled-cost replay on the same signals and quantities.

## Executable binding

- Module path: `services/bayn/src/strategy/dual-momentum-global-equity/candidate-18.ts`.
- Precommitted module SHA-256: `27466a8c9a9acba475db9cd0d2916532208540a53bd1f0ece307df299e5e34e8`.
- Module format: self-contained ESM with no imports.

The executable blob must first appear in a proper descendant of this preregistration commit and must match the precommitted SHA-256 exactly. Repository grafts, replacement objects, alternates, shallow history, stale evidence, tampered bindings, or any pre-existing executable blob fail closed before evaluation.

Exactly one metric-bearing Candidate 18 development evaluation is authorized after the preregistration commit is reviewed and its descendant source identity is verified. A rejection must record `DEVELOPMENT_REJECTED`, consume no qualification attempt, and keep the next preregistration null. A pass may commit only verified reviewed development evidence and must not execute qualification.
