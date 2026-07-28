# Candidate ordinal 5: robust cross-asset trend

Status: **frozen before qualification**

This document preregisters the fifth Bayn qualification candidate. The candidate is a genuinely new strategy identity,
not a rerun or relabeling of ordinal 4. The one natural qualification result is allowed to reject the hypothesis.

## Economic hypothesis and primary research

The hypothesis is that persistent own-market returns reflect slow information diffusion and hedging pressure, while a
diversified, volatility-scaled long-or-cash implementation can capture that persistence after conservative trading
costs. Moskowitz, Ooi, and Pedersen document time-series momentum across equity indices, bonds, currencies, and
commodities, including robustness across lookback horizons and volatility-scaled positions. Hurst, Ooi, and Pedersen
extend trend-following evidence across more than a century and many macroeconomic regimes. Faber studies a simple
cross-asset tactical allocation rule using liquid asset-class proxies.

Primary sources:

- Tobias J. Moskowitz, Yao Hua Ooi, and Lasse Heje Pedersen, “Time Series Momentum,” _Journal of Financial Economics_
  104 (2012), 228–250: <https://doi.org/10.1016/j.jfineco.2011.11.003>.
- Brian Hurst, Yao Hua Ooi, and Lasse Heje Pedersen, “A Century of Evidence on Trend-Following Investing,” _Journal of
  Portfolio Management_ 44 (2017), 15–29: <https://doi.org/10.3905/jpm.2017.44.1.015>.
- Mebane T. Faber, “A Quantitative Approach to Tactical Asset Allocation,” _Journal of Wealth Management_ 9 (2007),
  69–79: <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461>.

Bayn does not claim that those papers specify this exact rule. The candidate-specific robustness response is fixed from
ordinal 4's immutable attribution: 76 of 570 sleeve decisions allocated with only one or two positive horizons, while
the paired Sharpe-difference bootstrap was centered near zero. Candidate 5 therefore clips normalized horizon scores,
requires broad horizon agreement, and allocates by positive conviction per unit volatility. This is a structural
hypothesis chosen before reading the candidate window, not a promise of improvement.

## Frozen strategy and universe

| Binding                    | Frozen value                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Protocol                   | `bayn.risk-balanced-trend.protocol.v4`                                                    |
| Behavior hash              | `9e87fe0f66048c48da2191ef1fae36ef3ee0eb4ddcd036ef40881f0fe0f6eb42`                        |
| Parameter hash             | `19bc51c7361b181aa48845d178cb63373b3f2e017bcbea1cf3b70ab16647f8a9`                        |
| Fixture evaluation         | `81002ac221b557498e06cbcd9307d986ed21ff2c2ce883adcc489fef7f468416`                        |
| Universe                   | `DBC,EFA,IEF,SPY,VNQ`                                                                     |
| Universe ID/hash           | `cross-asset-taa-v1` / `c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8` |
| History/evaluation start   | `2016-01-04` / `2017-01-03`                                                               |
| Horizons                   | 21, 63, 126, and 252 sessions                                                             |
| Signal                     | normalized scores clipped to `[-2,2]`; median; at least 3 of 4 horizons positive          |
| Allocation                 | positive conviction divided by 63-session annualized volatility                           |
| Rebalance                  | month-end                                                                                 |
| Position policy            | long-or-cash                                                                              |
| Sleeve/portfolio risk caps | 35% per sleeve / 10% annualized portfolio volatility                                      |
| Initial simulated capital  | $1,000,000                                                                                |

## Frozen natural dataset

The untouched qualification window is the first normally scheduled finalized publication after ordinal 4's
`2026-07-24` snapshot. Manifest-only inspection selected the natural `2026-07-27` publication before any candidate bar,
return, weight, metric, benchmark comparison, or verdict was read.

| Binding                    | Frozen value                                                       |
| -------------------------- | ------------------------------------------------------------------ |
| Snapshot ID                | `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0` |
| Publication/evaluation end | `2026-07-27`                                                       |
| Provider/feed/adjustment   | Alpaca / SIP / all                                                 |
| Calendar                   | `alpaca-us-equity-calendar-v1`                                     |
| Selection rule             | first normally finalized snapshot strictly after `2026-07-24`      |

The candidate verifier must still establish byte-identical complete material on both physical ClickHouse replicas and
zero existing locks before GitOps may remove the ordinal-4 pin.

## Frozen execution, benchmarks, and gates

- Ordinary non-extended `DAY` market orders are simulated at the next session open from quantities planned after the
  signal session is finalized. Buys cannot spend planned sell proceeds.
- Price impact is 2.5 bps half-spread plus 2.5 bps slippage. Commission is zero; SEC, TAF, and CAT fees use the
  `alpaca-brokerage-2026-07-01` schedule. Ten percent of orders deterministically fill 50%; the remainder cancels.
- The double-cost gate doubles the declared spread, slippage, and fees. Costs and partial-fill assumptions cannot be
  weakened after observing the result.
- The comparison is the stronger of buy-and-hold and direct 10%-volatility timing, aligned to candidate sessions and
  exposure rules, on daily excess-over-cash returns.
- Economic gates require at least 504 observations, positive annualized net return, positive point Sharpe improvement,
  drawdown at most 35%, annual turnover at most 12x, and positive double-cost return.
- Statistical inference uses 5,000 paired complete-rebalance-block bootstrap samples, 5% family one-sided alpha with
  Bonferroni adjustment, at least 20 tail samples, and positive lower bounds for annualized excess return and Sharpe
  difference.
- Power requires 80% target power for a 3% annualized excess return at 10% tracking volatility, at least 504 sessions,
  and at least 24 complete rebalance blocks.
- Expanding-origin walk-forward requires at least five 252-session test folds after 504 training sessions, at least 60%
  positive-excess folds, and no fold drawdown above 35%.
- The complete prior-trial lineage is immutable and feeds the repository's multiplicity adjustment. Deflated Sharpe
  ratio and probability of backtest overfitting will be reported after the terminal run when they are identifiable from
  durable evidence; they are not silently substituted for, or used to weaken, the repository's locked gates.

## Complete prior-trial lineage

Candidate ordinal is fixed as `4 prior terminal trials + 1 = 5`:

1. `b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7` — `REJECTED`, insufficient sessions,
   blocks, and walk-forward folds.
2. `87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f` — `REJECTED`, insufficient sessions,
   blocks, and walk-forward folds.
3. `7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32` — `REJECTED`, non-positive
   Sharpe-difference lower confidence bound.
4. `440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861` — `REJECTED`, non-positive
   Sharpe-difference lower confidence bound.

The durable store sorts run IDs canonically when constructing the lock. The numbered list above is historical narrative,
not a replacement for that exact locked array.

## One-shot and authority contract

After source, multi-architecture image digest, runtime bindings, and the verified dataset are frozen, GitOps may deploy
the candidate once without `BAYN_QUALIFICATION_RUN_ID`. Bayn must create exactly one lock and one terminal result. The
operator then runs the source-pinned read-only audit twice and requires identical passing audit hashes before installing
the terminal run pin. `REJECTED` ends this task without adjustment or rerun. `QUALIFIED` remains evidence only: maximum
authority stays `OBSERVE`, broker mutations remain uncomposed, and capital promotion remains false.
