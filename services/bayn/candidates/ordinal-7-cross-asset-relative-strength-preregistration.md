# Candidate ordinal 7: cross-asset relative-strength rotation

Status: **frozen before the development evaluation**

This document preregisters Bayn Candidate 7 from source base
`accb27558050bec396f2ac963db951ca82c808b7`. Exactly one development evaluation is permitted. A failed result ends the
hypothesis without a parameter sweep, retry, relabel, or post-result adjustment. The 2023-01-03 through 2025-12-31
holdout is excluded from every query, input, diagnostic, metric, and decision in this development lane.

## Economic hypothesis and primary research

Candidate 7 tests whether medium-horizon **cross-sectional** winner persistence across broad asset classes survives a
causal, long-only ETF implementation with conservative costs. The mechanism is gradual information diffusion and
investor underreaction: asset classes with stronger returns from twelve months ago through one month ago should retain
relative strength over the next month. A positive absolute-return filter leaves weak selections in cash rather than
forcing exposure during broad declines.

This is materially different from Candidate 5, which aggregates each asset's own multi-horizon time-series trend, and
Candidate 6, which tested a short-horizon calendar-conditioned reversal. Candidate 7 ranks assets against one another
using one frozen 12-minus-1-month feature. It does not reuse Candidate 5's horizon consensus or Candidate 6's reversal
event.

Primary sources:

- Narasimhan Jegadeesh and Sheridan Titman, “Returns to Buying Winners and Selling Losers: Implications for Stock Market
  Efficiency,” _Journal of Finance_ 48 (1993), 65–91: <https://doi.org/10.1111/j.1540-6261.1993.tb04702.x>.
- Narasimhan Jegadeesh and Sheridan Titman, “Profitability of Momentum Strategies: An Evaluation of Alternative
  Explanations,” _Journal of Finance_ 56 (2001), 699–720: <https://doi.org/10.1111/0022-1082.00342>.
- Amit Goyal and Narasimhan Jegadeesh, “Cross-Sectional and Time-Series Tests of Return Predictability: What Is the
  Difference?”, _Review of Financial Studies_ 31 (2018), 1784–1824: <https://doi.org/10.1093/rfs/hhx131>.
- Mebane T. Faber, “Relative Strength Strategies for Investing” (2010):
  <https://doi.org/10.2139/ssrn.1585517>.
- Kent Daniel and Tobias J. Moskowitz, “Momentum Crashes,” _Journal of Financial Economics_ 122 (2016), 221–247:
  <https://doi.org/10.1016/j.jfineco.2015.12.002>.

The papers do not specify this exact Bayn rule. The rule below is fixed from their common medium-horizon ranking,
monthly holding, cross-asset diversification, absolute-strength hedge, and momentum-crash cautions before development
returns are evaluated.

## Frozen data and boundaries

| Binding | Frozen value |
| --- | --- |
| Candidate ordinal | `7` |
| Strategy identity | `bayn.cross-asset-relative-strength.v1` |
| Source-controlled universe | `DBC,EFA,IEF,SPY,VNQ` |
| Universe ID/hash | `cross-asset-taa-v1` / `c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8` |
| Provider/feed/adjustment | Alpaca / SIP / all |
| Publication schema | `signal.adjusted-daily-snapshot.v2` |
| Calendar | `alpaca-us-equity-calendar-v1` |
| History start | `2016-01-04` |
| Development simulation start | `2017-01-03` |
| Development end | `2022-12-30` |
| Untouched holdout | `2023-01-03` through `2025-12-31` |
| Development snapshot ID | `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0` |
| Publication as of | `2026-07-27` |
| Manifest content hash | `7b1216c8d698da4b2e74a5a77584c9863608edab0ad1c7331f37d039ddb1a764` |
| Raw manifest SHA-256 | `79400b64fcd981fc87874fbc0fd647033cfe8acadd1abb2f6a3f0af092699e43` |
| Raw bars SHA-256 | `c71ba30f3bcdd373708636f7c799d6caf3e24e07fd7d428522c69167c11a0c9c` |
| Raw sessions SHA-256 | `d0f182b5436c3ce374f4afaf2735c4b66247edfb78378aeff42af1efc889aabf` |
| Bounded bars content hash | `9fac08a198bac2dea6530e12a4406c695c84da8829b9a198f26511c822164785` |
| Bounded sessions content hash | `8fb5cf8accec311c6d34dd5d1074b9ac2cee38c51eaf906df26fd3479f48e358` |
| Official development sessions | `1762` |

Every symbol must have exactly one valid adjusted daily bar for every official development session. Missing, duplicate,
future-dated, wrong-universe, wrong-provenance, malformed, or hash-mismatched material fails closed. No imputation or
survivorship substitution is permitted.

## Frozen feature and decision rule

At the finalized close of each official month-end signal session `t`:

1. For each symbol, calculate one 12-minus-1-month relative-strength score:
   `adjustedClose[t-21] / adjustedClose[t-252] - 1`.
2. Rank all five symbols by descending score. Break exact ties by ascending symbol.
3. Select at most the top two symbols whose score is strictly positive. Non-positive selections remain cash.
4. Start from equal weights across the selected symbols. Estimate their covariance from the 63 close-to-close simple
   returns ending at `t`. Scale the complete selected portfolio down, never up, to a 10% annualized volatility target.
5. Cap each symbol at 50% and gross exposure at 100%. Do not redistribute weight removed by the volatility or symbol
   caps. The residual is cash. Shorting and leverage are forbidden.
6. Submit ordinary non-extended `DAY` market orders after the finalized signal close for execution at the next official
   session open. Sells execute before buys, but planned sell proceeds are unavailable to buys. The strategy holds the
   resulting positions until the next scheduled rebalance.

The final development position is liquidated using a boundary-known research close: the target becomes all cash after
the `2022-12-29` finalized close and executes at the `2022-12-30` open. No signal, order, mark, or metric may require a
session after `2022-12-30`.

## Frozen execution and costs

- Initial capital: `$1,000,000`.
- Price impact: `2.5` bps half-spread plus `2.5` bps slippage per side.
- Commission: zero.
- Regulatory fees: SEC `0.206` bps on sales, TAF `$0.000195` per sold share capped at `$9.79` per order, and CAT
  `$0.000003` per sold share, using the `alpaca-brokerage-2026-07-01` schedule.
- Quantity increment: `0.000001` share; price increment: `$0.0001`; minimum buy notional: `$1.00`.
- Partial fills: deterministic hash policy; 10% of orders fill 50% and the remainder cancels.
- Cash return: zero.
- Double-cost sensitivity: multiply spread, slippage, and regulatory fees by two; no other assumption changes.

## Frozen benchmark, statistics, and rejection thresholds

The benchmark is the stronger realized Sharpe of:

1. SPY buy-and-hold, aligned to Candidate 7's development observations; or
2. direct SPY volatility timing using a 63-session realized-volatility estimate, a 10% annualized target, long-or-cash,
   no leverage, and the same causal next-open execution and cost model.

Candidate 7 advances only if every existing Bayn gate passes:

- at least 504 comparable observations;
- annualized net return strictly above zero;
- development Sharpe strictly above the selected benchmark Sharpe;
- maximum drawdown at most 35%;
- annual turnover at most 12x;
- double-cost total return strictly above zero;
- positive one-sided lower confidence bounds for annualized excess-over-cash return and paired Sharpe difference;
- sufficient bootstrap tail resolution;
- sufficient 80% power for a 3% annualized excess return at 10% tracking volatility;
- expanding-origin walk-forward with 504 training sessions, 252-session test folds, at least five folds, at least 60%
  positive-excess folds, and no fold drawdown above 35%.

Inference uses exactly 5,000 paired complete-rebalance-block bootstrap samples. A complete block begins at one rebalance
execution and ends immediately before the next. Sampling is conventional non-wrapping moving-block sampling over the
ordered complete blocks. The one-sided family alpha is 5%, Bonferroni-adjusted for Candidate 7 and all six prior trials;
at least 20 tail samples are required. The bootstrap seed is deterministically bound to the evaluated run identity.

## One-shot disposition

There is one preregistered development run. No parameter sweep, alternative universe, retry, seed change, cost change,
feature replacement, threshold weakening, or post-result tuning is permitted. `PASS` retains only the minimal research
module and tests for review; it does not inspect the holdout, enter qualification, change production exports, grant
broker mutation, or enable capital. Any failed gate produces `HOLD_REJECT`; Candidate 7 implementation is then removed
from the final tree while the evaluated commit and exact evidence remain in Git history and the pull request.
