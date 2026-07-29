# Candidate ordinal 10: benchmark-anchored 52-week-high rotation

Status: **development family frozen before return-data access**

This document preregisters exactly one bounded Candidate 10 family. The family is evaluated once on the frozen Bayn
development calendar. No specification may be changed, added, removed, or rerun after development metrics are visible.
The untouched `2023-01-03` through `2025-12-31` holdout may be accessed only if one specification passes every frozen
development gate and its complete strategy and provenance identity is locked first.

## Measured defect and economic hypothesis

Candidates 6, 7, and 9 reduced risk without producing enough benchmark-relative return. Candidate 5's risk-balanced
trend rule also failed benchmark Sharpe and uncertainty gates. Candidate 10 therefore remains fully invested in SPY by
default and takes active risk only when another authorized asset is materially nearer its own trailing one-year high.
The intended return source is slow incorporation of information into prices, expressed through distance from an
asset-specific reference high rather than through volatility reduction, covariance minimization, calendar reversal,
or a 12-minus-1 cumulative-return ranking.

George and Hwang report that proximity to the 52-week high has predictive content beyond conventional past-return
momentum in US equities. Du tests the signal in international stock indexes and reports materially weaker extension,
which is a direct caution against assuming universality. Bianchi, Drew, and Fan study related 52-week-high behavior in
commodity futures. Bayn does not claim that those papers specify or validate this exact ETF rotation rule; they motivate
one small, falsifiable development family over Bayn's already authorized causal market data.

Primary sources:

- Thomas J. George and Chuan-Yang Hwang, “The 52-Week High and Momentum Investing,” _The Journal of Finance_ 59
  (2004), 2145–2176: <https://doi.org/10.1111/j.1540-6261.2004.00695.x>.
- Ding Du, “The 52-week high and momentum investing in international stock indexes,” _Quarterly Review of Economics
  and Finance_ 48 (2008), 61–77: <https://doi.org/10.1016/j.qref.2007.02.001>.
- Robert J. Bianchi, Michael E. Drew, and Jianxin Fan, “Commodities momentum: A behavioral perspective,” _Journal of
  Banking & Finance_ 72 (2016), 133–150: <https://doi.org/10.1016/j.jbankfin.2016.08.002>.

## Material distinction from Candidates 5–9

- Candidate 5 combines four own-return horizons, horizon agreement, volatility scaling, and risk budgeting. Candidate
  10 uses one trailing-high state variable, no volatility-scaled allocation, and no cash trend overlay.
- Candidate 6 is a month-end liquidity reversal. Candidate 10 is a persistent-reference-high continuation rule.
- Candidate 7 ranks 12-minus-1 cumulative returns and applies a positive absolute-strength cash filter. Candidate 10
  ranks current price relative to each asset's own trailing high, stays fully invested, and anchors every decision to
  SPY rather than rotating among all positive-score assets.
- Candidate 8 forecasts no return and allocates from covariance only. Candidate 10 is explicitly directional.
- Candidate 9 changes SPY exposure from an asymmetric volatility forecast. Candidate 10 keeps unit gross exposure and
  changes only the selected asset.

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

At each canonical official month-end finalized close:

1. For each symbol, read exactly the trailing 252 adjusted closes ending at that signal close.
2. Compute `highProximity = signalClose / max(trailing252Closes)`.
3. Identify the non-SPY challenger with the greatest high proximity; resolve an exact tie by ascending symbol.
4. Hold 100% of that challenger at the next official session open only when
   `challengerHighProximity > spyHighProximity + hurdle`.
5. Otherwise hold 100% SPY.

The rule is long-only, unlevered, and fully invested between rebalances. It has no cash filter, stop, volatility target,
covariance estimate, discretionary override, or intra-month trade. A signal may use only data finalized at or before
its close. Quantities use the signal close and execution occurs at the next official session open. The final research
simulation liquidates completely from the `2022-12-29` close at the `2022-12-30` open so all compared series terminate
inside the development boundary.

## Frozen bounded family and selection

Exactly three hurdle specifications are admitted:

| Specification         | Hurdle |
| --------------------- | -----: |
| `high-proximity-h000` | `0.00` |
| `high-proximity-h010` | `0.01` |
| `high-proximity-h020` | `0.02` |

All three are evaluated in one metric-bearing development invocation against byte-identical data, costs, benchmarks,
and gates. The family receives a three-way Bonferroni penalty before the repository's prior-trial adjustment: the
development family alpha is `0.05 / 3`, and the existing qualification analysis then divides by Candidate 10's ten
total ordinal attempts. The resulting one-sided development alpha is therefore `0.05 / 3 / 10 =
0.0016666666666666668`. No specification is admitted unless both adjusted lower bounds are strictly positive.

Among specifications that pass every economic, statistical, power, walk-forward, cost, and terminal-cash gate, select
the greatest annualized excess-return lower confidence bound. Resolve ties by greater Sharpe-difference lower bound,
then lower annual turnover, then ascending specification ID. If no specification passes, the entire family is
`HOLD_REJECT`; there is no second development run or improvised replacement family.

## Frozen execution costs and benchmarks

- Initial simulated capital is `$1,000,000`.
- The existing `defaultExecutionModel` is authoritative: next-session-open ordinary market execution, 2.5 bps
  half-spread, 2.5 bps slippage, the current zero-commission regulatory fee schedule, deterministic partial-fill model,
  integer-micros accounting, and buys bounded by pre-submit cash. Planned sell proceeds cannot fund planned buys.
- The double-cost simulation doubles the declared spread, slippage, and fees without changing signals or quantities.
- Benchmarks are SPY buy-and-hold and causal direct 10%-annualized-volatility timing of SPY. The stronger point-Sharpe
  benchmark is selected before applying the benchmark-relative gates.
- Candidate, benchmarks, and double-cost series use identical observation dates and terminal liquidation semantics.

## Frozen development and terminal gates

Development selection uses the merged `runCandidateDevelopment` entrypoint and its exact end-anchored geometry:

- 504 initial training observations;
- five chronological, non-overlapping 197-session development test folds;
- latest-contiguous observations ending `2022-12-30`;
- 252-session maximum causal feature lookback and one-session execution lag;
- 5,000 paired non-wrapping complete-rebalance-block bootstrap samples;
- at least 69 complete rebalance blocks and 1,449 complete sessions under the current power calculation;
- at least three of five positive-excess folds and no fold drawdown above 35%.

Each specification must also have at least 504 observations, positive annualized net return, strictly positive point
Sharpe improvement over the stronger benchmark, maximum drawdown at most 35%, annual turnover at most 12x, and positive
annualized return under double costs. The selection-adjusted annualized excess-return and Sharpe-difference lower bounds
must both be strictly positive.

If one development specification passes, its complete parameters, behavior, preregistration, source, dataset,
calendar, costs, benchmark, selection, and analysis identity must be immutably locked before any holdout I/O. The
official terminal qualification must then run exactly once through the existing qualification path using its unchanged
504-training plus five 252-session test-fold policy and the untouched holdout. No tuning or rerun is permitted after a
holdout metric is visible.

## Frozen prior-attempt lineage

The development analysis must use these nine canonically sorted prior attempt identities, including Candidate 9's
single development result:

1. `b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7`
2. `87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f`
3. `7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32`
4. `440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861`
5. `a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217`
6. `300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47`
7. `8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be`
8. `36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c`
9. `8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc`

The implementation must sort this set canonically before analysis; the narrative order above is not an alternate wire
order.

## One-shot and authority boundary

Exactly one metric-bearing development evaluation is allowed. A transport or query-schema failure before any metric
may be corrected only while every preregistered strategy, parameter, date, policy, cost, benchmark, and gate byte
remains unchanged. A development rejection consumes no terminal qualification trial and forbids holdout access.

Qualification evidence never authorizes deployment, PAPER or LIVE authority, broker mutation, order submission, or
capital promotion. Production remains on the existing rejected risk-balanced-trend identity in OBSERVE-only mode unless
a separate future authorization explicitly changes that boundary.
