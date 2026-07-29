# Candidate ordinal 14: intraday-information continuation rotation preregistration

Status: **PREREGISTERED — development returns and the 2023-2025 holdout have not been inspected**

This document freezes the only Candidate 14 research family before any query of development bars or any return-bearing
metric. Candidate 14 is one consumed family-level attempt whether its one evaluation passes, rejects, or is classified
`INVALID_PROTOCOL_DEVIATION`.

## Immutable lineage and attempt binding

- Fresh base: `e0d6f23814df4749f6c9432d6b53d5f8c9e00f80`.
- Candidate-development v2 source: `ad9a7477d645b4644c83384158783b2083fc7f88`.
- Deployed protocol image:
  `sha256:ad8c84a312bcf66cc998029b91f13e4e785f50e30351396e69a1b0f68183e881`.
- Candidate ordinal / prior trial count: `14` / `13`.
- Attempt rule: `candidateOrdinal = priorTrialCount + 1`; no replacement ordinal or post-result reset.
- Protocol schema: `bayn.candidate-development-protocol.v2`.
- Protocol identity for the 126-session lookback:
  `667a7f11b5fd317e20033457b6faa9225a52fe78d3fb40c271dfe72811d191fc`.
- Calendar: `bayn.candidate-development-calendar.v1`, 1,762 sessions, `2016-01-04..2022-12-30`, hash
  `a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1`.

The thirteen preceding family-attempt identities are frozen in canonical ascending order:

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

The fourth identity is Candidate 13's terminal outcome SHA-256. Candidate 13 produced no valid family run ID. Its closure
record is PR `#13366`, closed unmerged at `25273793dc39c883d108e25c24143e39c0f0494f`, preregistration commit
`3e8edb4f15d54f9d6be177c411062c3ee614c992`, preregistration SHA-256
`69d9f06cc53cc54265279ad969396bc6fa5d0aedea1c50eda78313a22d444af8`, and evaluated commit
`864c9f5d1c0867f31924357e913bed12df9c3b3d`. Its closure identity consumes the attempt without treating the failed
stressed replay as profitability evidence. The eleventh identity similarly records Candidate 12's invalid attempt.

## Distinct hypothesis and research

Candidates 5-13 consumed or ruled out robust own-market trend, month-end reversal, close-to-close 12-minus-1 relative
strength, minimum variance, asymmetric volatility management, 52-week-high rotation, abnormal-volume continuation,
same-calendar-month seasonality, and SPY-residual close-to-close momentum. Candidate 14 tunes none of them.

The sole hypothesis is that information incorporated while the market is open is underreacted to and therefore
continues, while overnight return is a different signal. Barardehi, Bogousslavsky, and Muravyev report momentum from
past intraday returns but not from past overnight returns. Candidate 14 deliberately uses only adjusted open-to-close
returns and excludes overnight and close-to-close returns.

Primary source: Yeganeh Barardehi, Vincent Bogousslavsky, and Dmitriy Muravyev, “What Drives Momentum and Reversal?
Evidence from Day and Night Signals,” _The Review of Financial Studies_ (2026), DOI `10.1093/rfs/hhag036`,
<https://doi.org/10.1093/rfs/hhag036>.

This five-ETF long-only rule is a falsifiable adaptation, not a reproduction or claimed validation of the paper.

## Frozen data and universe

- Snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Read-only tables: `signal.exchange_sessions_v1`, `signal.adjusted_daily_bars_v2`.
- Development bounds: `2016-01-04..2022-12-30`; universe: `DBC,EFA,IEF,SPY,VNQ`.
- Required fields: all-adjusted daily open, high, low, close, and volume.
- Require exactly one valid bar per symbol and official session; no imputation, forward fill, alternate snapshot, or
  missing-row tolerance.
- Every adjusted OHLC value must be finite, internally ordered, and at least `$5.00`; volume must be finite and positive.
  The `$5.00` floor is frozen for the analytical per-share fee bound, not from observed returns.
- Canonical hashes bind the ordered sessions and ordered `(session,symbol,OHLCV)` bars before evaluation.
- Only bounded calendar geometry may be materialized before this committed document. The first return-bearing query is
  forbidden until the implementation binds this document's exact SHA-256.

## Sole frozen specification

Strategy: `intraday-information-continuation-rotation`.

Specification: `intraday-relative-126-exposure90`. There is exactly one specification and no selection step.

At every official month-end finalized close:

1. Use exactly 126 adjusted open/close pairs ending on the signal session.
2. Compute each same-session intraday gross return as `adjustedClose / adjustedOpen`.
3. For every symbol, compute the product of the 126 gross returns minus one.
4. For each challenger in `DBC,EFA,IEF,VNQ`, subtract SPY's cumulative intraday return.
5. Fail closed on any non-finite or invalid input, gross return, product, cumulative return, or relative return.
6. A challenger is eligible only when its relative intraday return is strictly positive.
7. Select the greatest eligible value; break an exact tie by ascending symbol. If none is eligible, select SPY.

Feature values entering durable decision material are rounded to 12 decimal places. The rule uses no overnight,
close-to-close, trailing-high, volume, volatility, covariance, seasonality, regression, residual, or skip-period feature.
Future bars cannot alter a finalized decision.

Allocation and schedule are frozen as follows:

- Target `90%` of marked equity in the selected symbol and `10%` cash; every other weight is zero.
- Long-only, unlevered, one maximum position, gross target exposure exactly `0.90`.
- Signal and rebalance every canonical official month-end finalized close; execute at the next official session open.
- Liquidate from the finalized `2022-12-29` close at the `2022-12-30` open; all terminal weights are zero.

## Analytically derived non-borrowing reserve

The 10% reserve is fixed from the execution model and finite calendar before development bars. It does not use Candidate
13's failure amount or any candidate return.

- Doubling 2.5 bps half-spread plus 2.5 bps slippage adds 5 bps per fill. Micro rounding and `$0.0001` price quantization
  add less than 0.204 bps at the frozen `$5.00` floor; the bound is conservatively rounded to 5.25 bps per side.
- At `$5.00`, the additional TAF is at most 0.39 bps on sells, SEC is 0.206 bps on sells, and CAT is at most 0.006 bps
  per side. Caps and partial fills only reduce the envelope.
- Existing long positions can represent at most 100% of marked equity and new buys target at most 90%. A complete
  sell-and-buy execution is therefore bounded by
  `1.00 * (5.25 + 0.39 + 0.206) + 0.90 * 5.25 + 1.90 * 0.006 = 10.5824` basis points,
  plus at most three `$0.01` fee-rounding increments.
- The calendar permits at most 77 eligible monthly executions plus terminal liquidation. Conservatively treating all 78
  as complete sell-and-buy transitions gives `78 * 10.5824 = 825.4272` basis points and at most `$2.34` of aggregate
  fee-rounding overhead.
- The 10% reserve exceeds the 8.254272% finite-schedule normalized cost envelope. Exact causal replay must still prove
  non-negative cash; the analytical reserve never waives that fail-closed check.

## Simulation, costs, and doubled-cost causal path

- Initial capital: `1000000000000` micros ($1,000,000).
- Shared simulation and `defaultExecutionModel` are authoritative.
- Regular-session `DAY` market orders are planned from signal close and filled at next-session open. Same-session sell
  proceeds cannot fund buys.
- Half-spread and slippage are 2.5 bps each; current deterministic SEC, TAF, CAT, partial-fill, precision, and fee-rounding
  contracts remain unchanged.
- Baseline multiplier: `1000000`; stressed multiplier: `2000000`.

The baseline uses the shared simulator with event recording. The stressed run causally replays the exact ordered baseline
signal decisions and exact requested/filled quantities, using shared fill, fee, cash-yield, position, and marking rules at
`2x`. It may recompute prices, costs, cash, positions, marks, returns, and performance, but may not generate quantities.

Negative cash, malformed evidence, absent orders, impossible positions, or any changed signal/quantity path fails closed.
`runCandidateDevelopment` must verify equal canonical hashes for signals, ordered quantities, and execution models before
returning a report. Any breach is terminal `INVALID_PROTOCOL_DEVIATION`, consumes Candidate 14, and permits no rerun.

## Development geometry, multiplicity, and gates

- Lookback: 126 sessions.
- First eligible signal/execution: `2016-07-29` / `2016-08-01`.
- Available observations: 1,617; unused eligible observations: 128.
- Selected observations: 1,489, `2017-02-02..2022-12-30`.
- Walk-forward: 504 initial observations and five chronological 197-observation folds:
  `2019-02-05..2019-11-13`, `2019-11-14..2020-08-26`, `2020-08-27..2021-06-09`,
  `2021-06-10..2022-03-21`, `2022-03-22..2022-12-30`.
- Family specifications: 1; prior attempts: 13.
- Adjusted one-sided alpha: `0.05 / 14 = 0.0035714285714285718`.
- Paired complete non-wrapping rebalance-block bootstrap: 10,000 samples; nearest-rank lower tail: 35 samples; minimum: 20. Seed, block construction, power policy, fold boundaries, and alpha interpretation are unchanged v2 values.

The exact same sessions compare the candidate with SPY buy-and-hold and the existing causal direct SPY 10%-volatility
benchmark. The greater point-Sharpe benchmark is stronger; an exact tie selects buy-and-hold.

Every development gate must pass:

- at least 504 observations and positive annualized candidate return;
- candidate point Sharpe strictly above the stronger benchmark;
- maximum drawdown at most 35% and annual turnover at most 12x;
- positive annualized return under conforming invariant-path `2x` costs;
- strictly positive adjusted annualized excess-return and Sharpe-difference lower confidence bounds;
- sufficient complete blocks and sessions under shared power policy;
- at least three of five folds with positive excess return and no fold drawdown above 35%;
- terminal cash for candidate baseline, candidate stress, buy-and-hold, and direct-volatility paths.

No weighted score, near-pass, alternate benchmark, or post-result reinterpretation exists.

## One-shot, holdout, and authority boundary

After this file is committed, implementation and tests may use only synthetic fixtures until the evaluated implementation
commit and this document's commit/SHA-256 are fixed. V2 preflight must pass before I/O. Then exactly one metric-bearing
query/evaluation may run over the frozen development snapshot.

A transport failure before metrics may be repaired only without changing these bytes, evaluated behavior, query, or
identity. Once any return, performance metric, fold, bootstrap value, or gate appears, Candidate 14 is consumed and may
not be rerun, retuned, reseeded, repaired, substituted, or reframed. A valid failed gate is `HOLD_REJECT`; a contract
breach is `INVALID_PROTOCOL_DEVIATION`. Either non-pass requires executable-code removal, honest Markdown evidence only,
and a closed unmerged PR. A complete development `PASS` may retain minimal code in a ready PR, but still authorizes no
holdout access or terminal qualification.

The holdout is exactly `2023-01-03..2025-12-31` and remains:

```text
inspected=false
accessCount=0
```

No query may mention, span, summarize, hash, count, or inspect a holdout date. This task authorizes no terminal
qualification, broker access, capital grant, database write, runtime composition, deployment, manifest, GitOps,
authority, or order mutation.
