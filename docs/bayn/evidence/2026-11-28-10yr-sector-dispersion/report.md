# Bayn Wave 21H: sector dispersion and relative-strength rotation

**DO NOT PROMOTE.** Across 2,513 out-of-sample sessions, the registered rotation earned **+14.76% net**
at 5 bp round trip, versus **+277.17%** for SPY and **+19.43%** for SHY. Its annualized market-adjusted
alpha was **−7.52%** (95% interval **[−14.64%, +0.03%]**). Allocating 25% to the rotation made the
incumbent F4+O1+B0 stack worse on Sharpe, Calmar, and maximum drawdown at both 5 and 10 bp, in the
complete OOS path and terminal holdout. Positive nominal return alone did not pass the registered gate.

## Pre-registered protocol

**Question.** Does a daily long-only sector rotation earn positive net, SPY-risk-adjusted alpha or
improve the existing Bayn portfolio after trading costs? The 10-year scoring window is retrospective:
time separation protects the rule from lookahead, not from prior Bayn research on the same archive.

**Inputs.** Use only the split- and dividend-adjusted Alpaca SIP daily bars from
`agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/` for the candidate. Verify the
manifest, its ETF roster and the archive byte receipts. Rank the 11 GICS ETFs (`XLK`, `XLF`, `XLE`,
`XLV`, `XLI`, `XLY`, `XLP`, `XLU`, `XLB`, `XLC`, `XLRE`) plus `SMH`. `SPY` is the market reference,
`QQQ` is a growth benchmark only, and `SHY` is the defensive allocation and rate proxy. Use real
bars only. An ETF must have 64 consecutive completed closes to be eligible; no proxy for XLC before
inception and no filling of XLRE's gaps. Unavailable benchmark or held/ordered marks, inadequate
breadth, or a failed archive/control check reject the run rather than drop a session.

**Signal and walk-forward.** At close \(t\), rank by 63-session log return minus SPY's log return,
breaking ties by ticker. For each eligible name compute annualized sample volatility of its last 21
daily log returns minus SPY's corresponding log returns. Dispersion is the cross-sectional sample
standard deviation of those volatilities; require at least 10 eligible names. At or above the
dispersion threshold, target the top three with equal weights; otherwise target 100% SHY. Run one
ungated top-three ablation with identical eligibility, fills, and costs. It cannot replace the
candidate or trigger promotion.

Use the tape from 2016-01-04 for initialization only. Score the ten years from the 2016-11-25 close
through the 2026-11-25 close (first eligible order 2016-11-28). At the start of each calendar-year
fold, including the partial first fold, set the threshold to the interpolated 60th percentile of
the 126 session dispersion readings ending at the prior close, and keep it fixed for that fold.
Carry holdings across fold boundaries. Report all out-of-sample (OOS) sessions, the 2022–2023
validation window and the 2024–2026 terminal holdout separately. No rule or variant is selected
by returns in any fold.

**Execution and costs.** Decide whether to rebalance from the prior-close weights. Do not trade if
the larger of desired buys or sells is at most 10% of equity. Apply accepted targets at the next
session open with fractional shares and a fully funded book. Charge half the round-trip rate on
the absolute dollar value of each buy and sell, funding costs from the book. The four fixed stress
rates are 0, 2, 5, and 10 bp round trip; no other sleeve fee is assumed. Returns are booked
close-to-close: overnight gaps accrue to old shares, next-open fills and costs occur before the
open-to-close mark. Start in cash, pay for initial entry, and mark terminal holdings without a
forced exit. Historical opening bars do not establish executable auction prices or capacity.

**Controls and blends.** Compare adjusted SPY and QQQ buy-and-hold and SHY, plus the exact historical
SHY-idle `F4-42-1-LQD-parity`, `ensemble/base/21/0.05` (O1), and Wave 9B B0 replays. F4/O1 need their
original DIA/UUP supplement and B0 its original SIP intraday tapes; these are used only to reproduce
the controls, never to trade or form the rotation signal. Keep the controls' native fees and verify
their published split totals before scoring. Pair by the same close-booking dates. Compare 25%
rotation + 75% control with each of SPY, F4, O1, and B0 alone, and with the equal F4+O1+B0 stack.
For multicomponent portfolios, reset capital weights daily and charge the same per-side rate on
gross transfers. These are separately funded sleeve blends, not shared-account netting or an
assumption of zero correlation.

**Inference and decision.** Compound daily net returns; annualize Sharpe (zero hurdle), growth
and one-way turnover at 252 sessions; Calmar uses CAGR divided by positive peak-to-trough max
drawdown. Report same-session Pearson correlations. Estimate annualized market alpha as 252 times
the OLS intercept of rotation minus SHY on SPY minus SHY. Use paired circular stationary blocks
(10,000 draws, mean block 10 sessions, seed `0x21a2026`) and percentile 95% intervals for alpha
and the change in portfolio Sharpe. Refit beta and recalculate both Sharpes with the same drawn
indices. These intervals do not adjust for earlier Bayn studies; control blends other than the
stack are descriptive.

Only 5 bp (primary) and 10 bp (stress) govern the verdict. Require positive net return at both
costs on both the complete OOS path and terminal holdout and at least one of these two routes to
pass on **all four** cost/window pairs:

1. **Alpha:** lower 95% bound of annualized SPY/SHY-adjusted alpha strictly above zero.
2. **Portfolio:** lower 95% bound of paired Sharpe lift versus F4+O1+B0 strictly above zero, higher
   point Calmar, and lower point max drawdown.

Undefined required statistics fail the gate. A `PROMOTE` result could only warrant a new
prospective study; neither verdict changes runtime policy, accounts, or trading authority.

## Measured evidence

The [registration was pushed](https://github.com/proompteng/lab/commit/cb527a6d69cafe644d5ea24e4d7eccfa7ff41573)
after checking manifest membership and before reading price rows. The 11 calendar-year folds, including
partial 2016 and 2026, cover the exact 10-year close-to-close interval. Validation comprises 501
sessions (2022-01-03 to 2023-12-29); terminal holdout comprises 729 (2024-01-02 to 2026-11-25). These
are subsets of OOS, not independent replications. [Results](results.json) retain each fold's
calibration cutoff and threshold, annual net returns, the three reporting windows, all costs, the
control receipts, and daily-path digests.

### Standalone rotation

Net returns are cumulative; maximum drawdown is a positive loss magnitude.

| RT cost | OOS net | OOS Sharpe | OOS Calmar | OOS max DD | Holdout net | Holdout Sharpe | Holdout Calmar | Holdout max DD |
| ------: | ------: | ---------: | ---------: | ---------: | ----------: | -------------: | -------------: | -------------: |
|    0 bp | +28.75% |      0.238 |      0.068 |     38.00% |     +37.97% |          0.866 |          0.759 |         15.51% |
|    2 bp | +22.96% |      0.210 |      0.055 |     38.11% |     +35.70% |          0.825 |          0.707 |         15.74% |
|    5 bp | +14.76% |      0.167 |      0.036 |     38.28% |     +32.38% |          0.763 |          0.632 |         16.10% |
|   10 bp |  +2.29% |      0.095 |      0.006 |     38.56% |     +27.01% |          0.660 |          0.516 |         16.69% |

At 5 bp, the rotation returned **−11.93%** in validation, versus **+3.24%** for SPY. It traded on 499
OOS sessions and held SHY on 1,227; annualized one-way turnover was **23.07×** even with the deadband.
The ungated ablation returned **+114.98%** at 5 bp with a **0.494** Sharpe and **36.54%** maximum
drawdown. The dispersion gate did not improve OOS risk-adjusted returns versus the identical ungated
rule, even at zero cost; the ablation is not a replacement candidate.

| Cost / window   | Annualized SPY-adjusted alpha | Paired stationary 95% interval |
| --------------- | ----------------------------: | -----------------------------: |
| 5 bp / OOS      |                        −7.52% |              [−14.64%, +0.03%] |
| 5 bp / holdout  |                        +0.79% |             [−12.50%, +13.34%] |
| 10 bp / OOS     |                        −8.67% |              [−15.80%, −1.11%] |
| 10 bp / holdout |                        −0.65% |             [−13.97%, +11.93%] |

### Incremental portfolio value

Arrows show the equal F4+O1+B0 stack before and after allocating 25% to the rotation. The paired
interval is for the change in Sharpe (after minus before).

| Cost / window   |        Sharpe | 95% interval for Δ Sharpe |        Calmar |         Max DD |
| --------------- | ------------: | ------------------------: | ------------: | -------------: |
| 5 bp / OOS      | 1.419 → 0.913 |          [−0.818, −0.148] | 0.795 → 0.398 | 9.22% → 15.13% |
| 5 bp / holdout  | 1.884 → 1.617 |          [−0.938, +0.306] | 2.656 → 2.186 |  4.01% → 4.89% |
| 10 bp / OOS     | 1.066 → 0.666 |          [−0.704, −0.055] | 0.578 → 0.281 | 9.38% → 15.31% |
| 10 bp / holdout | 1.562 → 1.352 |          [−0.841, +0.368] | 2.068 → 1.751 |  4.22% → 5.05% |

At 5 bp, rotation's OOS correlations to SPY/F4/O1/B0 were **+0.712 / +0.525 / +0.541 / −0.037**.
The near-zero correlation with B0 did not translate into higher OOS B0-blend Sharpe. The B0-only
blend did lift holdout Sharpe by 0.183, but the paired interval [−0.300, +0.769] included zero. No
single-control blend improved OOS Sharpe at 5 bp. Neither the alpha nor the portfolio route passed.

## Provenance and reproduction

All 15 tickers matched the base manifest. Thirteen have all 2,741 source sessions. XLC has 2,122 rows
starting 2018-06-19; XLRE has 2,739 rows (missing 2016-01-25 and 2016-02-16). Eligibility respects
those gaps; no missing prices were filled. The first executed decision used 2016-11-25 closes and
selected SMH, XLI, and XLE. The dispersion was 5.110%, above the first fold's 4.816% threshold.

| Base archive identity                                       | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `MANIFEST.json`                                             | `ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e` |
| `alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz` | `fdda4017ee662fae548d8111a970ea90d83b3e8ee6f61abd6153be0fe83547d2` |
| Decoded tape (450,712 rows)                                 | `e5331bb57e6f6427449d0cd3ab59291f56e508cb8c3961557bfd1374a635c9a8` |

Control replays matched the [published F4, O1 and B0 split receipts](../2026-11-27-10yr-event-calendar-overnight-etf/report.md).
Stationary intervals resample the realized daily paths and condition on the registered rule, not
on a new search over thresholds. There is no prospective observation or execution-capacity proof.

From the repository root with read access to the existing Rook-Ceph `agents-artifacts` bucket:

```sh
out=$(mktemp -d)
bun services/bayn/tools/research-10yr-sector-dispersion.ts --output "$out/results.json"
bunx oxfmt --config .oxfmtrc.json --write "$out/results.json"
cmp "$out/results.json" docs/bayn/evidence/2026-11-28-10yr-sector-dispersion/results.json
unlink "$out/results.json"
rmdir "$out"
```
