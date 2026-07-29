# Bayn Candidate 9 preregistration: asymmetric range-volatility-managed equity

Status: `PREREGISTERED_DEVELOPMENT_ONLY`

This record freezes Candidate 9 before any Candidate 9 return query or evaluation. The candidate may use only the
development calendar from `2016-01-04` through `2022-12-30`. The holdout from `2023-01-03` through `2025-12-31`
must remain unread until one development specification passes and the complete executable identity is locked.

## Prior-candidate diagnosis

- Candidate 5, robust cross-asset trend, reached terminal qualification and was rejected because it did not improve
  benchmark Sharpe and its confidence bounds did not establish positive benchmark-relative performance.
- Candidate 6, SPY month-end liquidity reversal, produced development Sharpe `0.5561433659477207` versus SPY
  buy-and-hold `0.6386425320738072`; its annualized-return interval
  `[-0.0010095656992797435, 0.03036320620238341]` and Sharpe interval
  `[-0.02703043492393884, 1.214213314331432]` crossed zero. It was rejected without holdout access.
- Candidate 7, cross-asset 12-minus-1 relative strength, produced development Sharpe `0.401526` versus the stronger
  buy-and-hold benchmark `0.507698`; its adjusted annualized-excess lower bound was `-0.054096427811` and its
  Sharpe-difference lower bound was `-0.728942931735`. It was rejected without holdout access.
- Candidate 8, long-only shrinkage minimum variance, was rejected before return-data access because the former
  development geometry could not fit five folds. Candidate-development protocol v1 now fixes only that development
  feasibility defect; terminal qualification remains unchanged.

The common defect is not raw profitability. It is weak and unstable post-cost benchmark-relative Sharpe. Candidate 9
therefore uses no trend, reversal, ranking, expected-return estimate, or covariance optimizer. It manages one broad
equity exposure from a causal forecast of downside-sensitive realized variance.

## Research basis and economic hypothesis

- Moreira and Muir, “Volatility-Managed Portfolios,” *Journal of Finance* 72 (2017), working-paper version:
  https://doi.org/10.3386/w22208. Exposure that falls when volatility is high can improve Sharpe when expected returns
  do not rise proportionally with variance.
- Fleming, Kirby, and Ostdiek, “The Economic Value of Volatility Timing,” *Journal of Finance* 56 (2001):
  https://doi.org/10.1111/0022-1082.00327. Conditional volatility information can have economic value after costs.
- Parkinson, “The Extreme Value Method for Estimating the Variance of the Rate of Return,” *Journal of Business* 53
  (1980): https://doi.org/10.1086/296071. High-low ranges contain variance information unavailable from closes alone.
- Patton and Sheppard, “Good Volatility, Bad Volatility,” *Review of Economics and Statistics* 97 (2015):
  https://doi.org/10.1162/REST_a_00503. Negative-return variation is more persistent and informative for future equity
  volatility than positive-return variation.

Hypothesis: a monthly, long-or-cash SPY strategy using an asymmetric OHLC variance estimate will reduce exposure
before persistent adverse volatility regimes and produce a positive, selection-adjusted post-cost Sharpe difference
against both passive SPY and Bayn's existing direct-volatility benchmark.

## Frozen specification and bounded selection budget

Candidate ordinal: `9`

Strategy: `asymmetric-range-volatility-managed-equity`

Version: `1.0.0`

Selection budget: exactly one specification. There is no parameter search, alternative window, threshold, estimator,
symbol, schedule, or second development run. The multiplicity penalty counts all eight preceding candidate attempts,
including Candidate 8's pre-data feasibility attempt; Candidate 9 is analyzed at one-sided alpha `0.05 / 9` through
the existing canonical lineage mechanism.

Universe: `SPY` only. Cash is the only residual allocation. No leverage, shorts, derivatives, volume signal, or
unavailable feature is permitted.

Authorized market input: finalized Alpaca SIP adjusted daily OHLCV, adjustment `all`, publication schema
`signal.adjusted-daily-snapshot.v2`, snapshot
`2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`, calendar
`alpaca-us-equity-calendar-v1`. Development queries must be explicitly bounded at `2022-12-30`.

Signal schedule: every canonical official month-end finalized close. The decision executes at the immediately
following official session open. The final development position is liquidated using the `2022-12-29` finalized close
for execution at the `2022-12-30` open so no development position wraps beyond the boundary.

Feature window: the 21 completed sessions ending on the signal session, plus the immediately preceding close needed
for the first close-to-close return. Missing, duplicate, malformed, future-dated, wrong-provenance, or incomplete data
fail closed; no interpolation or imputation is allowed.

For each feature session `i`:

```text
rangeVariance_i = log(high_i / low_i)^2 / (4 * log(2))
negativeVariance_i = min(log(close_i / close_(i-1)), 0)^2
```

The forecast and target are:

```text
forecastDailyVariance = mean(rangeVariance_i + 2 * negativeVariance_i)
targetDailyVariance = 0.10^2 / 252
SPY weight = min(1, targetDailyVariance / forecastDailyVariance)
cash weight = 1 - SPY weight
```

Weights are deterministic, finite, non-negative, rounded to 12 decimal places, and capped at 100% gross exposure.
Zero forecast variance fails closed rather than manufacturing leverage.

Execution and costs: Bayn `bayn.execution-model.v2` unchanged—market order, next-session open, no extended hours,
2.5 bps half-spread plus 2.5 bps slippage per fill, the source-controlled SEC/TAF/CAT fee schedule, deterministic
10% half fills with canceled remainder, no use of same-session sale proceeds for buys, and an explicit double-cost
simulation. Initial capital is `$1,000,000`.

Benchmarks: the stronger realized Sharpe of (1) fully invested SPY buy-and-hold and (2) Bayn's causal 63-session
direct-volatility SPY strategy targeting 10% annualized volatility. Both use the same next-open execution model,
calendar, costs, and terminal liquidation.

## Frozen development and terminal policy

Development calendar: exactly 1,762 official sessions from `2016-01-04` through `2022-12-30`, canonical calendar
hash `a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1`.

Development geometry: `runCandidateDevelopment` must enforce 504 training sessions plus five chronological,
non-overlapping 197-session development test folds. The existing candidate-development policy, canonical month-end
schedule, preflight-before-data ordering, bootstrap implementation, and fold boundaries must not be changed.

Development passes only when all of the following hold on net modeled returns:

- Bayn economic verdict `PASS`: non-negative annualized return, positive Sharpe improvement over the stronger
  benchmark, maximum drawdown at most 35%, annual turnover at most 12x, and positive double-cost return.
- Existing power gate passes with at least 69 complete rebalance blocks and 1,449 complete sessions.
- The existing paired complete-block bootstrap is non-wrapping, produces all 5,000 samples, has sufficient tail
  resolution at adjusted one-sided alpha `0.05 / 9`, and has both annualized excess-return and Sharpe-difference lower
  bounds strictly above zero.
- Exactly five 197-session chronological folds are present, at least three have positive cash-relative return, and
  every fold drawdown is at most 35%.
- The report records net return, benchmark-relative annualized return, strategy and benchmark Sharpe, drawdown,
  turnover, all fold outcomes, bootstrap bounds, costs, hashes, and the singleton selection penalty.

Any development failure is terminal for this family. The holdout must remain unread, Candidate 9 must not be
consumed, executable candidate code must be removed, and the branch/PR must close unmerged.

Only after development passes may one exact strategy identity be locked. Then, and only then, exactly one official
terminal qualification may use `2023-01-03` through `2025-12-31` with the unchanged official five-252-session policy.
There is no tuning, rerun, date change, estimator change, or replacement candidate after holdout access.

This preregistration grants no production strategy switch, broker mutation, PAPER/LIVE authority, or capital.
