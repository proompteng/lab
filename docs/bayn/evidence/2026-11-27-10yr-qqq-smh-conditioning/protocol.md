# Wave 9B preregistration: causal QQQ + SMH conditioning

## Question and boundary

Can a fixed volatility filter/size, breakout confirmation, or protective exit improve the
[Wave 6A](https://github.com/proompteng/lab/pull/16387) B0 control at both 2 and 5 bp round trip?
This is research only. The underlying ETF pair, baseline and both price periods were already observed in earlier
waves. Holdout is out-of-sample for **Wave 9B development selection**, not a never-seen market sample or prospective
validation. The motivating hypothesis is that a weak volatility environment may not clear friction; no calendar year
is dropped or treated specially.

| Split      | First session | Last session | Sessions |
| ---------- | ------------- | ------------ | -------- |
| Train      | 2016-01-04    | 2021-12-31   | 1,511    |
| Validation | 2022-01-03    | 2023-12-29   | 501      |
| Holdout    | 2024-01-02    | 2026-11-25   | 729      |

Use Wave 6A's SHA-256-pinned S3 manifests, exchange calendars and tapes in `agents-artifacts`:
`bayn-research-datasets/2026-11-27-sip-8yr-5m-unseen-v2/` for development,
`bayn-research-datasets/2026-11-27-sip-multiyear/` for Holdout, and
`bayn-research-datasets/2026-11-27-sip-10yr-sp100/` for adjusted daily SHY.
Authenticate all 174,598,869 development bytes but decode only the first 174,597,176 (one complete gzip member;
1,693 authenticated trailing bytes). Preserve every official session and early close; no price imputation.
Carry lagged feature histories, not positions, across both split seams.

Commit this protocol and implementation before development evaluation. Generate `freeze.json` on the 2,012
development sessions only; commit and push it before accessing any Holdout or SHY prices for this study.
`--score` verifies the published branch revision, the original committed receipt and locked source bytes, and
reproduces the canonical JSON payload before requesting Holdout prices. It cannot reselect on Holdout.

## Control and 27-cell grid

`B0_base` is exactly Wave 6A's `B0/30/1.4/opposite_band/inverse_vol_parity`, with the same fixed $100,000 sleeve,
integer shares, $180,000 conservative gross ceiling and costs. Verify zero-cash net to the cent against Wave 6A at
both costs in each split and the 2,741-session full window (rounded full: $103,534 and $69,780). A mismatch aborts.
The full Cartesian product below includes the baseline as `V0/R0/X0`; 26 upgrades and one fixed basket diagnostic
make 28 total configurations. No tuning over thresholds, clocks, spreads, symbols, years, or trailing triggers.

| Code | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V0   | Wave 6A inverse-volatility parity on the fixed gross budget.                                                                                                                                                                                                                                                                                                                                                                                                |
| V1   | Leave a symbol's allocation in cash if the sample standard deviation of its previous 14 official open-to-close returns is below 0.60% (equal passes). Never increase another allocation to compensate.                                                                                                                                                                                                                                                      |
| V2   | On the same prior 14 sessions, form the daily series of open-to-close returns of today's inverse-vol weights, thereby including the lagged cross-name covariance. Multiply all budgets by min(1, 10% / annualized sample volatility of this long-only proxy), using sqrt(252). Zero proxy volatility leaves the budget unchanged; incomplete inputs withhold the book. It is a sizing proxy, not a guarantee about realized long/short strategy volatility. |
| R0   | No extra confirmation.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R1   | Cumulative RTH volume through the completed checkpoint bar must be at least the median cumulative volume at that clock for the previous 14 sessions that reached the clock. No look-through for missing bars in those sessions; shorter scheduled sessions that never reached that clock are skipped.                                                                                                                                                       |
| R2   | Strict close above RTH VWAP for a long or below it for a short. Use archived 5m VWAP weighted by completed cumulative volume; equality or any missing prefix bar fails.                                                                                                                                                                                                                                                                                     |
| X0   | Wave 6A opposite-band close or timed flatten.                                                                                                                                                                                                                                                                                                                                                                                                               |
| X1   | X0 plus a catastrophic stop 1.5× prior ATR14 from the raw entry open. ATR is the Wave 6A mean true range of the prior 14 sessions; no entry without positive complete ATR, no cross-name reallocation.                                                                                                                                                                                                                                                      |
| X2   | X1 plus a one-way move of the stop to the raw entry open after a completed 5m close shows gross open profit at least the full upper-minus-lower band width at entry decision. This protects raw price breakeven, not costs. Only later bars can hit the newly armed stop.                                                                                                                                                                                   |

All cells use the Wave 6A gap-aware band: mean absolute move from RTH open to that checkpoint over the previous
14 sessions reaching it, scaled by 1.4, anchored to the max/min of today's open and previous RTH close.
A missing open, prior return, required checkpoint or prior close withholds the corresponding input. Inverse-vol
weights use the same 10 bp volatility floor as Wave 6A; it does not affect the V1 threshold. Enter once per
symbol/day on the first confirmed strict breakout, at the next 5m bar open, with no retry after a missing entry
open. A rejected checkpoint is not an order; it allows later confirmed checkpoints. Decision clocks are 10:00–15:00
ET, with the last early-close checkpoint no later than close minus 30 minutes. No intraday reallocation, reversal,
re-entry, or overnight position.

An opposite-band close at a checkpoint or a completed held-bar high/low touching the applicable stop requests
exit at the next observed 5m open, not a fill at the trigger. If a bar both touches the existing stop and could arm
the profit lock, the existing stop wins; no OHLC ordering assumption. Forced flatten starts 15 minutes before
regular or early close, retrying missing opens at minus ten and minus five. A missing exit remains unresolved; a
held-bar gap or gross-bound breach is reported and vetoes qualification. Apply Wave 6A's adverse half of each fixed
round-trip cost on both fills and 0.21 bp on the sell. Quantities are shared across costs. Bar replay is not a
consolidated quote, impact, borrow, financing, or broker execution model.

## Selection and gates

Use 5 bp zero-cash daily P&L, including zero-trade sessions. Exclude any candidate without a defined Sharpe,
gap-free closed legs, and gross within the ceiling in **both complete development windows**; never remove sessions.
Keep the top three upgrades by Train Sharpe, then select the highest Validation Sharpe of those three (ties by
lexical ID). Neither baseline, diagnostic, Holdout nor carry can choose a contender. If none is eligible, freeze
no contender. Persist the full rankings, development ledger digest, fingerprints and selection.

Freeze a per-cost daily DSR benchmark from sample dispersion of all defined Train grid Sharpes, using all
27 configurations as the multiplicity in the expected maximum of independent standard normals. Use the existing
skew/kurtosis-adjusted daily DSR. It adjusts for this grid, not earlier research waves or serial dependence.
Use the one-sided centered circular stationary block bootstrap on the **aligned daily dollar P&L differences**
(candidate minus B0), 10,000 draws, geometric mean block length five, seed `0x6a202611`, plus-one p-value.
Use the same draw indices across costs and comparisons. An unresolved pair withholds inference, rather than dropping a day.

Promote only the frozen contender, and only if **at both 2 and 5 bp** Holdout delta is positive with paired
`p < 0.05`, DSR is `>= 0.95`, and Holdout net and ex-top-ten net are positive. Require complete gap-free held paths
within the gross ceiling across the full replay for both contender and control. Report all 26 Holdout comparisons
as descriptive ablations; their nominal p-values are not corrected across the full Holdout sweep and cannot select a
different winner. If no preregistered contender passes, keep pure B0. Recommend adding only the catastrophic stop
(`V0/R0/X1`) as a safety exception if it has no lower net or Sharpe, no higher MaxDD, and no held-path defects
in **each** split at both costs; this is observed non-degradation, not a noninferiority inference.

## Separate diagnostics

Replay the exact B0 rule including weights, clock, exit and costs on QQQ + SMH + XLK. XLK was available pre-2016;
its approximately 0.5 bp quoted spread is context, not a special fill assumption. Compare Sharpe, maximum dollar
drawdown and net at both costs on Train, Validation, pooled development, Holdout and Full; show annual net for
stability. No retuning or promotion from these results.

Show the same standalone statistics with a separate, continuously held $100,000 SHY total-return sleeve funded
at the first observed close, adding daily mark changes (no first-day carry or reinvestment of trading P&L).
No carry enters Sharpe deflation, paired inference, or selection: all reported upgrade gates refer to zero-cash
alpha. Neither the SHY scenario nor any result grants live or capital authority.
