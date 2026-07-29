# Candidate ordinal 12: same-calendar-month seasonal excess rotation

Status: **development specification frozen before return-data access**

This document preregisters exactly one Candidate 12 specification. It may be evaluated once on Bayn's frozen
development calendar. No symbol, feature, parameter, date, cost, benchmark, gate, allocation, tie-break, selection
rule, or prior-attempt identity may change after any development return or metric is visible. The untouched
`2023-01-03` through `2025-12-31` holdout may be accessed only if this frozen specification passes every development
gate and its complete identity is immutably locked first.

## Measured defect and economic hypothesis

Candidate 11 was profitable and passed every point gate, but it returned `10.4023441454%` annualized versus SPY at
`13.0507084495%`; its annualized excess-return lower bound was `-4.6115233279%` and its Sharpe-difference lower bound
was `-0.390033520515`. Candidates 5-10 also failed to establish positive benchmark-relative evidence. Candidate 12
therefore remains long-only, unlevered, and fully invested, uses no cash or defensive overlay, and takes active risk
only from a return predictor expressed directly as expected excess over SPY.

The hypothesis is annual return seasonality: an asset that outperformed SPY in a particular calendar month one year
earlier is more likely to outperform SPY in that same calendar month again. Recurrent institutional flows, tax and
reporting cycles, and other persistent calendar-specific demand can create a same-month component that is distinct
from ordinary contiguous momentum or reversal. The rule uses only the immediately preceding annual lag because Bayn's
frozen development protocol permits at most 252 causal sessions.

Primary sources:

- Steven L. Heston and Ronnie Sadka, “Seasonality in the Cross-Section of Stock Returns,” _Journal of Financial
  Economics_ 87 (2008), 418-445: <https://doi.org/10.1016/j.jfineco.2007.02.003>.
- Matti Keloharju, Juhani T. Linnainmaa, and Peter Nyberg, “Return Seasonalities,” _The Journal of Finance_ 71 (2016),
  1557-1590: <https://doi.org/10.1111/jofi.12398>.
- Steven L. Heston and Ronnie Sadka, “Seasonality in the Cross Section of Stock Returns: The International Evidence,”
  _Journal of Financial and Quantitative Analysis_ 45 (2010), 1133-1160:
  <https://doi.org/10.1017/S0022109010000451>.

Bayn does not claim that these papers specify or validate this exact ETF rule. They motivate one small, falsifiable
same-calendar-month specification over Bayn's existing authorized adjusted-daily universe.

## Material distinction from Candidates 5-11

- Candidate 5 uses multi-horizon own-market trend, volatility scaling, and risk budgeting. Candidate 12 uses one
  noncontiguous annual calendar lag, no volatility estimate, and no risk target.
- Candidate 6 is a month-end liquidity reversal. Candidate 12 predicts the next complete calendar month's relative
  return from the same month one year earlier and does not use a reversal feature.
- Candidate 7 ranks contiguous 12-minus-1 returns and can hold cash. Candidate 12 uses only the prior year's matching
  calendar month and is always fully invested.
- Candidate 8 allocates from covariance alone. Candidate 12 forecasts return and uses no covariance matrix.
- Candidate 9 changes SPY exposure using asymmetric volatility. Candidate 12 keeps unit gross exposure and uses no
  volatility timing.
- Candidate 10 ranks distance from a trailing 52-week high. Candidate 12 ignores trailing highs and all contiguous
  52-week trend information.
- Candidate 11 uses abnormal dollar volume plus recent relative return and a fixed SPY core/challenger sleeve.
  Candidate 12 uses no volume, no recent-return continuation filter, no fixed core, and holds exactly one asset.

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

At each canonical official month-end finalized close, identify the next official session and therefore the calendar
month that will be held. For each symbol, identify every official session in that same calendar month exactly one year
earlier. Compute the prior-season return as:

`last adjusted close of the prior-season month / first adjusted open of that month - 1`.

For each non-SPY symbol, compute `seasonalExcess = symbolPriorSeasonReturn - spyPriorSeasonReturn`. Select the symbol
with the greatest strictly positive seasonal excess; resolve a tie by greater raw prior-season return, then ascending
symbol. If no non-SPY symbol has strictly positive seasonal excess, select SPY.

Target 100% of capital in the selected symbol and zero in every other symbol. The rule is long-only, unlevered, fully
invested, and rebalances only at canonical official month ends. It has no cash filter, fixed benchmark sleeve,
volatility target, stop, covariance estimate, volume feature, trailing-high feature, discretionary override, or
intramonth trade.

Every signal uses only bars finalized at or before its signal close. The selected target executes at the next official
session open. The first admitted signal must satisfy the frozen 252-session causal-lookback declaration. The final
research simulation liquidates completely from the `2022-12-29` finalized close at the `2022-12-30` open so all
compared series terminate inside the development boundary.

## Frozen singleton family and selection

Exactly one specification is admitted:

| Specification                     | Annual lag | Predictor                         | Allocation |
| --------------------------------- | ---------: | --------------------------------- | ---------: |
| `same-month-seasonal-excess-lag1` |          1 | prior same-month return minus SPY | top 1/100% |

The bounded-selection multiplicity is exactly one. Candidate 12 follows eleven prior attempts, so the unchanged
Bonferroni adjustment yields a one-sided alpha of `0.05 / 12 = 0.004166666666666667`. The frozen 5,000-sample
bootstrap therefore has `floor(5000 * 0.05 / 12) = 20` lower-tail samples, exactly the current minimum. The sole
specification is selected only if it passes every economic, statistical, power, walk-forward, cost, and terminal-cash
gate. Otherwise Candidate 12 is `HOLD_REJECT`; there is no second development run or replacement family.

## Frozen execution costs and benchmarks

- Initial simulated capital is `$1,000,000`.
- The existing `defaultExecutionModel` is authoritative: next-session-open ordinary market execution, 2.5 bps
  half-spread, 2.5 bps slippage, the current zero-commission regulatory fee schedule, deterministic partial fills,
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
- 252-session causal feature lookback and one-session execution lag;
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

The development analysis must use these eleven canonically sorted prior-attempt identities:

1. `300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47`
2. `36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c`
3. `440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861`
4. `7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32`
5. `87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f`
6. `8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be`
7. `8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc`
8. `9c495c857a67659a56ca9381ff03d6839cf1812abbf70c73bc75de372bcaf118`
9. `a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217`
10. `b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7`
11. `bf19a5d8b29032146effeadca2bf129924c9062dd5b516a0483927207c333cfc`

The implementation must sort and verify this exact set canonically before analysis. The list includes Candidate 11's
single frozen development family run and no extra or omitted attempt.

## One-shot and authority boundary

Exactly one metric-bearing development evaluation is allowed. A transport or query-schema failure before any metric
may be corrected only while every preregistered strategy, parameter, date, policy, cost, benchmark, selection, and gate
byte remains unchanged. A development rejection consumes no terminal qualification trial and forbids holdout access.

Qualification evidence never authorizes deployment, PAPER or LIVE authority, broker mutation, order submission, or
capital promotion. Production remains on the existing risk-balanced-trend identity in OBSERVE-only mode unless a
separate future authorization explicitly changes that boundary.
