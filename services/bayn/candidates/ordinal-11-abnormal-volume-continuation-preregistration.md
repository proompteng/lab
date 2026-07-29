# Candidate ordinal 11: benchmark-anchored abnormal-volume continuation

Status: **development specification frozen before return-data access**

This document preregisters exactly one Candidate 11 specification. It may be evaluated once on Bayn's frozen
development calendar. No parameter, date, cost, benchmark, gate, universe, signal, allocation, or selection rule may
change after any development return or metric is visible. The untouched `2023-01-03` through `2025-12-31` holdout may
be accessed only if the frozen specification passes every development gate and its complete identity is immutably
locked first.

## Measured defect and economic hypothesis

Candidates 5, 7, 9, and 10 failed to produce positive benchmark-relative evidence. Candidates 9 and 10 in particular
reduced annualized return materially below SPY. Candidate 11 therefore does not use a cash or volatility-defense
overlay. It remains fully invested, holds a fixed SPY core, and takes bounded active risk only when another authorized
asset has both positive one-month return relative to SPY and an abnormal recent dollar-volume shock.

The economic hypothesis is that unusually high trading activity reveals attention and information arrival, and that a
positive price response to that activity continues over the following month rather than immediately reversing. The
fixed SPY core is not a drawdown optimization; it limits the amount of benchmark return surrendered while the active
sleeve tests the return-seeking hypothesis.

Primary sources:

- Simon Gervais, Ron Kaniel, and Dan H. Mingelgrin, “The High-Volume Return Premium,” _The Journal of Finance_ 56
  (2001), 877-919: <https://doi.org/10.1111/0022-1082.00349>.
- Charles M. C. Lee and Bhaskaran Swaminathan, “Price Momentum and Trading Volume,” _The Journal of Finance_ 55
  (2000), 2017-2069: <https://doi.org/10.1111/0022-1082.00280>.
- Narasimhan Jegadeesh and Sheridan Titman, “Returns to Buying Winners and Selling Losers: Implications for Stock
  Market Efficiency,” _The Journal of Finance_ 48 (1993), 65-91: <https://doi.org/10.1111/j.1540-6261.1993.tb04702.x>.

Bayn does not claim that these papers specify or validate this ETF rule. They motivate one small, falsifiable
specification using only Bayn's already authorized causal adjusted daily data.

## Material distinction from Candidates 5-10

- Candidate 5 combines own-market trend horizons, volatility scaling, and risk budgeting. Candidate 11 uses no
  volatility estimate, risk target, or multi-horizon trend score.
- Candidate 6 is a calendar-conditioned month-end liquidity reversal. Candidate 11 is continuation after positive
  price response to abnormal activity.
- Candidate 7 ranks 12-minus-1 cumulative returns and can move to cash. Candidate 11 uses a 21-session directional
  filter only after a 5-versus-58-session dollar-volume shock, retains a fixed SPY core, and never moves to cash.
- Candidate 8 allocates from covariance alone. Candidate 11 forecasts return and uses no covariance estimate.
- Candidate 9 changes SPY exposure from asymmetric volatility. Candidate 11 keeps unit gross exposure and uses no
  volatility overlay.
- Candidate 10 ranks distance from a trailing 52-week high and rotates fully into one asset. Candidate 11 uses no
  trailing high and allocates only a fixed challenger sleeve selected by abnormal dollar volume.

## Frozen data, calendar, and universe

| Binding                  | Frozen value                                                       |
| ------------------------ | ------------------------------------------------------------------ |
| Source base              | `d00b261e6ea41ce5f44c0aea2a19a878d0df8162`                         |
| Snapshot                 | `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0` |
| Development interval     | `2016-01-04` through `2022-12-30` only                             |
| Development calendar     | 1,762 sessions, `alpaca-us-equity-calendar-v1`                     |
| Calendar canonical hash  | `a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1` |
| Untouched holdout        | `2023-01-03` through `2025-12-31`                                  |
| Universe                 | `DBC,EFA,IEF,SPY,VNQ`                                              |
| Provider/feed/adjustment | Alpaca / SIP / all-adjusted daily OHLCV                            |

The command must materialize and verify the complete bounded official calendar before its first adjusted-bar query. It
must reject a missing, duplicate, unordered, out-of-universe, misaligned, non-finite, or hash-inconsistent row. The
development query may not request any date after `2022-12-30`.

## Frozen signal and allocation

At each canonical official month-end finalized close, use exactly 63 causal sessions ending at that close.

For each non-SPY symbol:

1. Compute recent average dollar volume from the final 5 sessions as
   `mean(adjustedClose * adjustedVolume, T-4 through T)`.
2. Compute baseline average dollar volume from the preceding 58 sessions as
   `mean(adjustedClose * adjustedVolume, T-62 through T-5)`.
3. Compute `abnormalDollarVolume = recentAverage / baselineAverage`.
4. Compute the symbol's 21-session return as `adjustedClose[T] / adjustedClose[T-21] - 1`.
5. Compute SPY's 21-session return over the same finalized sessions.
6. Compute `relativeReturn = symbolReturn - spyReturn`.

A non-SPY symbol is eligible only when `abnormalDollarVolume >= 1.25` and `relativeReturn > 0`. Select the eligible
symbol with the greatest abnormal dollar-volume ratio; resolve a tie by greater relative return, then ascending symbol.

If a challenger is selected, target 50% SPY and 50% challenger. Otherwise target 100% SPY. All other weights are zero.
The rule is long-only, unlevered, fully invested, and rebalances only at canonical official month ends. It has no cash
filter, volatility target, stop, covariance estimate, trailing-high feature, discretionary override, or intramonth
trade.

Every signal uses only bars finalized at or before its signal close. Execution occurs at the next official session open.
The final research simulation liquidates completely from the `2022-12-29` finalized close at the `2022-12-30` open so
all compared series terminate inside the development boundary.

## Frozen singleton family and selection

Exactly one specification is admitted:

| Specification                | Recent/baseline windows | Volume threshold | Relative return | SPY/challenger |
| ---------------------------- | ----------------------: | ---------------: | --------------: | -------------: |
| `attention-volume-v125-s050` |                    5/58 |             1.25 |            `>0` |          50/50 |

The bounded-selection multiplicity is therefore exactly one. Candidate 11 follows ten prior attempts, so the existing
Bonferroni adjustment yields a one-sided alpha of `0.05 / 11 = 0.004545454545454546`, producing 22 lower-tail samples
from the frozen 5,000-sample bootstrap. The sole specification is selected only if it passes every economic,
statistical, power, walk-forward, cost, and terminal-cash gate. Otherwise Candidate 11 is `HOLD_REJECT`; there is no
second development run or replacement family.

## Frozen execution costs and benchmarks

- Initial simulated capital is `$1,000,000`.
- The existing `defaultExecutionModel` is authoritative: next-session-open ordinary market execution, 2.5 bps
  half-spread, 2.5 bps slippage, the current zero-commission regulatory fee schedule, deterministic partial-fill model,
  integer-micros accounting, and buys bounded by pre-submit cash. Planned sell proceeds cannot fund planned buys.
- The double-cost simulation doubles the declared spread, slippage, and fees without changing signals or quantities.
- Benchmarks are SPY buy-and-hold and causal direct 10%-annualized-volatility timing of SPY. The stronger point-Sharpe
  benchmark is selected before applying benchmark-relative gates.
- Candidate, benchmarks, and double-cost series use identical observation dates and terminal liquidation semantics.

## Frozen development and terminal gates

Development selection uses the merged `runCandidateDevelopment` entrypoint and its exact end-anchored geometry:

- 504 initial training observations;
- five chronological, non-overlapping 197-session development test folds;
- latest-contiguous observations ending `2022-12-30`;
- 63-session causal feature lookback and one-session execution lag;
- 5,000 paired non-wrapping complete-rebalance-block bootstrap samples;
- at least 69 complete rebalance blocks and 1,449 complete sessions under the current power calculation;
- at least three of five positive-excess folds and no fold drawdown above 35%.

The specification must also have at least 504 observations, positive annualized net return, strictly positive point
Sharpe improvement over the stronger benchmark, maximum drawdown at most 35%, annual turnover at most 12x, and positive
annualized return under double costs. The prior-attempt-adjusted annualized excess-return and Sharpe-difference lower
bounds must both be strictly positive.

If development passes, the complete parameters, behavior, preregistration, source, dataset, calendar, costs, benchmark,
selection, and analysis identity must be immutably locked before any holdout I/O. The official terminal qualification
must then run exactly once through the existing qualification path using its unchanged 504-training plus five
252-session test-fold policy and the untouched holdout. No tuning or rerun is permitted after a holdout metric is
visible.

## Frozen prior-attempt lineage

The development analysis must use these ten canonically sorted prior-attempt identities:

1. `300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47`
2. `36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c`
3. `440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861`
4. `7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32`
5. `87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f`
6. `8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be`
7. `8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc`
8. `a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217`
9. `b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7`
10. `bf19a5d8b29032146effeadca2bf129924c9062dd5b516a0483927207c333cfc`

The implementation must sort and verify this exact set canonically before analysis. The list includes Candidate 10's
single frozen development result and no extra or omitted attempt.

## One-shot and authority boundary

Exactly one metric-bearing development evaluation is allowed. A transport or query-schema failure before any metric
may be corrected only while every preregistered strategy, parameter, date, policy, cost, benchmark, selection, and gate
byte remains unchanged. A development rejection consumes no terminal qualification trial and forbids holdout access.

Qualification evidence never authorizes deployment, PAPER or LIVE authority, broker mutation, order submission, or
capital promotion. Production remains on the existing risk-balanced-trend identity in OBSERVE-only mode unless a
separate future authorization explicitly changes that boundary.
