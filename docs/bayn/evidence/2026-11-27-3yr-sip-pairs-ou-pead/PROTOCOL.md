# Wave 2F pre-registered protocol: SIP pairs and gap drift

This is retrospective, point-in-time-by-bar research on a fixed contemporary cohort, not a deployment or capital
request. The frozen holdout is scored once the source-bound, development-only receipt is committed. No fallback
winner, threshold changes, data substitutions, or selection by holdout. A null is missing evidence, not zero.

## Inputs and chronology

| Resolution | Train                         | Validation                    | Frozen holdout                |
| ---------- | ----------------------------- | ----------------------------- | ----------------------------- |
| 5-minute   | 2024-01-02 through 2025-06-30 | 2025-07-01 through 2026-03-31 | 2026-04-01 through 2026-11-25 |
| Daily      | 2021-01-04 through 2024-06-30 | 2024-07-01 through 2025-08-31 | 2025-09-01 through 2026-11-25 |

- Bind the manifest's two compressed and uncompressed byte hashes, sizes and row counts. Stream, hash, and discard
  every row beyond each development cutoff without parsing its prices or volumes in `--freeze`. `--score` checks the
  exact committed receipt, code and reproduced development results before decoding holdout prices. Cross-resolution
  features are not shared. Positions never cross split boundaries; strictly prior feature history may.
- Use the matching frozen Alpaca calendar already published at the sibling `2026-11-27/` S3 prefix. The key at the
  requested multiyear prefix does not exist. Reapply calendar RTH to the mislabeled 5m extract (it contains
  extended-hours rows); honor DST and early closes without timestamp shifts or backfill. For daily dates before the
  calendar begins, use the SPY session spine from the verified daily archive; cross-check all overlapping dates.
- Respect regular-way dates for the newer securities and symbol transitions recorded in the
  [protocol source](../../../../services/bayn/tools/pairs-pead-protocol.ts), including [Sandisk's 2025-02-24 regular-way start
  after when-issued trading](https://www.sec.gov/Archives/edgar/data/2023554/000119312525033433/d849281d8k.htm),
  [GE Vernova's spin-off](https://www.sec.gov/Archives/edgar/data/1996810/000119312524131304/d783090ds1a.htm)
  and [Arm's IPO](https://investors.arm.com/investor-info/faqs). Require 20 strictly prior exchange sessions for
  each leg (including SPY); rolling features also require actual valid prior observations. Do not map predecessor
  or when-issued rows to regular-way history.
- Both feeds already price NVDA on the post-split scale across June 10, 2024; do not apply a second split. The
  daily split-day high is discontinuous relative to the verified RTH range. Do not use that day's range in
  daily ATR. Signal on later days only when the full clean ATR window is observable.
  [NVIDIA split FAQ](https://investor.nvidia.com/files/doc_downloads/2024/06/nvidia-2024-stock-split_faq_investors.pdf).
  WDC prices straddle its announced separation without adjusting for the Sandisk distribution. Flatten WDC
  inventory on February 21 at the open, block entries through February 24, and restart feature history on
  February 24. Do not monetize the mechanical price gap.
  [WDC separation notice](https://www.westerndigital.com/company/newsroom/press-releases/2025/2025-02-24-western-digital-completes-planned-company-separation).

## Grid and execution rules

**Pairs.** Run all 23 user-specified linked pairs together on each trial, not as independently selected winners.
The 20- or 40-session prior window fits OLS log price A on log price B with intercept, uses residual RMS
(with residual degrees of freedom) for standardized spread, and estimates AR(1) on the prior residuals. A
nonpositive/degenerate slope or vanishing residual variance is not tradable. Grid: entry magnitude 1.5/2/2.5,
with no filter, OU half-life ≤10 sessions (only 0 < AR coefficient < 1), or log-return Pearson correlation ≥0.70.
These are alternative residual mean-reversion screens, not a claim of formal cointegration. Enter opposite the
spread, exit at magnitude ≤0.25, ≥4, or deadline. Do not open at or past the stop. Intraday uses prior RTH closes
and current completed 5m bars, from 10:00 ET. Swing uses prior daily closes, decisions at completed daily close,
and each of the 1–10 session deadlines; enter, exit and rebalance at the next open. No same-close fill.
[Avellaneda–Lee](https://doi.org/10.1080/14697680903124632) and
[Gatev–Goetzmann–Rouwenhorst](https://doi.org/10.1093/rfs/hhj020) motivate residual and relative-value reversion,
not the profitability of this universe.

**Gap continuation.** Trade the sign of an opening gap at least 1.5 or 2.0 times prior ATR14 (arithmetic mean true
range); require opening 5m or 15m volume ≥2.5 times that identical window's mean over 20 strictly prior sessions
and a candle with the gap sign. Both variants decide at 09:45 (the first 5m feature is frozen when it completes)
and fill the 09:45 bar open. Intraday ATR uses full regular-session ranges plus prior RTH closes. The five-year
swing proxy substitutes the completed daily candle and full-day RVOL; enter on the next day open and test
1–5 holding sessions. The daily archive cannot identify earnings releases or prove historical 5m/15m volume;
neither experiment is labelled as timestamp-matched earnings. This is PEAD-style gap re-pricing research,
motivated by [Bernard–Thomas](https://doi.org/10.2307/2491062), not an earnings-surprise test.

**Exhaustion fade.** Require a 2 ATR gap and 15m RVOL ≥2.5 but the opening 15m candle must oppose the gap by
at least 0.25 ATR. Fade at 09:45 with alternative prior-close or evolving regular-session volume-weighted price
targets; no entry if the 09:45 decision has already reached the target. For all gap variants, a completed bar
crossing a 1 ATR protective/trailing threshold based on the _prior_ favorable extreme triggers a next-open exit.
Update the favorable extreme after checking the stop. No optimistic wick fills or retroactive stop adjustment.
The frozen manifest's 50-name core contains four ETFs, not 50 stocks. Run the 46-stock cohort as the qualification
universe; the core sensitivity adds IWM/QQQ/SMH and uses the 50th name, SPY, as a hedge only in both cohorts.

**Book.** $180,000 maximum gross target at synchronized fills, with equal fixed gross sleeves and opposite
equal-dollar legs. OU beta defines the signal scale; execution equalizes dollars, not OLS notionals. Every gap
position has a SPY hedge; offsetting sleeves are kept separate and charged independently. Any mark-to-market
exposure drift between opens is measured, not assumed away. Intraday exits at the last RTH bar open (15:55 or
12:55 ET) at the latest. All orders execute on the next bar open after the decision, including stops; missing leg
on an entry cancels it. Missing mandatory exit/hold marks invalidate the affected window for qualification.
Liquidate an unresolved holding at the next supported synchronized open within the same split. Never carry an
unresolved position into the next split. At daily split ends flatten at the last scheduled open. Slippage is
2/5/10 bp round trip, charged half per side on actual traded dollars, plus 0.21 bp per sell and 1.5% annually
on marked short inventory across nights (ACT/365). Positions use fractional shares; bar opens and modeled NBBO
stress are not realized quotes. No spread feed, dynamic locate fees, queue/auction timing, dividends, intrabar
fill simulation or impact/capacity model are available. The fixed cohort is subject to survivorship bias.

## Evidence and qualification

Report all 230 configurations (18 intraday OU, 180 swing OU, 8 intraday gap, 20 swing gap and 4 fades), at all
three round-trip stresses. Each trial records Train, Validation, Frozen Holdout, all, every calendar year and every
half-year. Days are marked, not assigned entirely to trade exit dates. Ex-Top-5 removes the best five portfolio
days within that window, including cash days if applicable. Leave-One-Pair-Out/LOSO removes one fixed cash sleeve
without redistributing it (exact replay equivalence because units share no budgets, prices or selections).
Use 10,000 deterministic circular null-centered bootstrap draws of five-session blocks for intraday and ten-session
blocks for daily. Use one-sided add-one p-values, no p-value for constant or insufficient series, and report
Deflated Sharpe (DSR) from the variance of complete, nondegenerate Train daily Sharpes with the full count of
registered configurations of that frequency, including diagnostic universes.

Freeze at most one candidate per engine: highest 10 bp Train daily Sharpe among positive, fully supported Train
paths with at least 20 closed positions; break ties by trial ID. Do not substitute another if validation fails.
Require in **each** split at 10 bp: ≥20 exits, positive P&L and Ex-Top-5 P&L, bootstrap p < 0.05, DSR ≥0.95,
absolute realized daily P&L beta to SPY ≤0.10, and ≥75% positive adjacent single-axis configurations. Neighbors
use adjacent holding periods and entry-z values; categorical alternatives and the two-value axes are adjacent.
The cohort axis is never used to demonstrate a plateau. Also require positive holdout P&L at 2 and 5 bp and
positive holdout P&L in every leave-one-out run at 10 bp. Only such a frozen candidate is eligible for an
unwired v3 primitive. Nothing in this artifact changes the live v2 policy or grants execution authority.
