# Wave 18D — Sector ETF opening gaps and B0 expansion

**DO NOT PROMOTE any expansion or gap variant.** Keep QQQ + SMH as the research control. Adding XLK raised
Holdout net by **$1,971** and Sharpe by **0.057** at 5 bp in the inverse-vol book, but the paired bootstrap
gave **p = 0.238**, DSR was **0.698**, and the p10 bar-capacity proxy fell from **$477k to $271k**. No larger
universe improved Holdout Sharpe. The best 5 bp opening-gap result was **$1,141 over 16 active sessions**;
it lost **$1,793** after its ten best days were removed. Neither result warrants a SIP strategy change.

## Sample and audit trail

- [Registered protocol](protocol.md) and implementation were committed in
  [`7f4ef072a`](https://github.com/proompteng/lab/commit/7f4ef072a669759d00b13de1be93f27231bbb1d7)
  before scoring. The study evaluates 11 Noise Area books and 32 gap variants with no Holdout reselection.
  Holdout is chronological, not an unseen market sample: earlier waves used these periods.
- All **2,741 official sessions** from January 4, 2016 through November 25, 2026 were retained, including
  21 early closes and 60 common warmup sessions. The original SIP archives cover 10 of the 13 symbols.
  The separate **639,098-row** Alpaca SIP 5-minute supplement for XLB, XLP and XLU covers every session
  for those symbols; no frozen inputs were edited. [Results][archived-results] records the calendar, daily,
  frozen intraday and supplemental byte receipts, per-name gaps and 11 annual liquidity elections.
- The registered 5 bp DSR reference uses **39 defined Train Sharpes** on **1,510** common resolved Train
  sessions and the full **43-trial** count. The expected maximum null daily Sharpe was **0.06155**.
  The primary one-sided Holdout bootstrap threshold was **0.0011905** (0.05/42), with 10,000 circular
  stationary draws and a five-session mean block length.
- The frozen tape has no qualifying flatten open on **2019-08-12** for an entered leg in the IWM and
  broader books. Their official 2019, Train and Full net are **unknown**, not zero. The separate
  2,740-session matched Full sensitivity omits that single date from every book; it cannot qualify a
  candidate. Broader books also record a missed entry or held-bar gap on **2020-03-18**. No deadline
  was moved to resolve a price gap. The Holdout has no unresolved fills in the registered books.

## Track A — Noise Area breadth and friction

Official Holdout net on a fixed $100,000 reference; all costs are adverse **round-trip** scenarios, and
all include the 0.21 bp sell fee. **DO NOT PROMOTE** every expansion below; B0 is a control, not a candidate.

| Universe / sizing        |    0 bp |  2.5 bp |    5 bp |    10 bp | 5 bp vs B0 |
| ------------------------ | ------: | ------: | ------: | -------: | ---------: |
| B0 / inverse vol         | $46,320 | $38,974 | $31,628 |  $16,936 |          — |
| B0 + XLK / inverse vol   | $48,380 | $40,989 | $33,599 |  $18,819 |    +$1,971 |
| B0 + XLK / equal risk    | $48,331 | $40,941 | $33,550 |  $18,769 |    +$1,922 |
| B0 + XLK + IWM / inv vol | $33,076 | $25,524 | $17,971 |   $2,866 |   −$13,657 |
| B0 + XLK + IWM / eq risk | $31,997 | $24,441 | $16,885 |   $1,773 |   −$14,743 |
| B0 + Top3 / inverse vol  | $12,352 |  $4,588 | −$3,177 | −$18,706 |   −$34,805 |
| B0 + Top3 / equal risk   | $10,972 |  $3,202 | −$4,567 | −$20,106 |   −$36,196 |
| B0 + Top6 / inverse vol  |  $9,743 |  $1,839 | −$6,065 | −$21,873 |   −$37,693 |
| B0 + Top6 / equal risk   |  $9,281 |  $1,412 | −$6,458 | −$22,196 |   −$38,086 |
| All13 / inverse vol      |  $9,630 |  $1,744 | −$6,142 | −$21,915 |   −$37,771 |
| All13 / equal risk       |  $9,195 |  $1,346 | −$6,503 | −$22,201 |   −$38,131 |

At 5 bp, adding XLK with inverse volatility moved Calmar from **2.023 to 2.081**, worsened MaxDD by
**0.177 percentage points**, added **3.55× equity** of cumulative two-sided turnover, and increased
breakeven from **15.76 to 16.37 bp**. Median capacity fell from **$1.331m to $703k**; the daily return
correlation to B0 was **0.980**. Equal risk gave nearly the same result. The subsequent IWM addition
cost **$15,628**, **0.454 Sharpe** and **1.084 Calmar** against the inverse-vol XLK rung, while increasing
turnover **12.98×** and shrinking breakeven **5.42 bp**. Its p10 capacity proxy rebounded relative to the
XLK rung but remained below the original B0. The top-K and All13 books break even at only **2.93–3.98 bp**
and lose money at 5 bp. The [machine-readable file][archived-results] gives unrounded deltas in Sharpe, Calmar,
MaxDD, turnover, breakeven and both capacity percentiles versus B0 and the previous same-weight rung.

The p10 and median capacity figures are modeled capital at 1% participation in the limiting observed
5-minute bar, not executable capital. Bar opens are not executable quotes; printed volume includes
trades after the order and provides no fill, locate, market-impact or borrow proof.

## Track B — Sector opening gaps

**DO NOT PROMOTE** all 32 variants. At 0 / 2.5 / 5 / 10 bp, **16 / 13 / 7 / 3** variants respectively
had positive Holdout net. All three positive at 10 bp were dollar-neutral fades on fewer than 30
sessions, two using the same two qualifying days. No long-only variant survived 10 bp. The highest
5 bp dollar result (60m medium aligned dollar-neutral fade) had **0.44 Sharpe, 0.157 DSR, p = 0.220,
−0.07 correlation** to B0, **12.14 bp** breakeven and **$342** net at 10 bp. Its low correlation is
not evidence of durable diversification: most dates were cash, and the pair is dollar-, not beta-neutral.

The table shows 5 bp Holdout net at both horizons and the number of active sessions (identical across
horizons here). Medium means 0.25 to <0.75 ATR; large means ≥0.75 ATR. The [results][archived-results] preserve
all costs, p-values at 5 bp, DSR, risk, turnover, capacity, correlations and verdict reasons per cell.

| Direction    | Book           | Size   | Prior close | Days |  30m net |  60m net |
| ------------ | -------------- | ------ | ----------- | ---: | -------: | -------: |
| Fade         | Dollar-neutral | Medium | Aligned     |   16 |    −$646 |   $1,141 |
| Fade         | Dollar-neutral | Medium | Opposed     |   19 |     $528 |     $690 |
| Fade         | Dollar-neutral | Large  | Aligned     |    8 |    −$124 |     −$24 |
| Fade         | Dollar-neutral | Large  | Opposed     |    2 |     $380 |     $282 |
| Fade         | Long-only      | Medium | Aligned     |  104 |  −$1,931 |     $203 |
| Fade         | Long-only      | Medium | Opposed     |  159 |  −$9,582 | −$10,032 |
| Fade         | Long-only      | Large  | Aligned     |   50 |  −$2,687 |  −$6,147 |
| Fade         | Long-only      | Large  | Opposed     |   46 |    −$918 |    −$459 |
| Continuation | Dollar-neutral | Medium | Aligned     |   16 |  −$1,020 |  −$2,808 |
| Continuation | Dollar-neutral | Medium | Opposed     |   19 |  −$2,508 |  −$2,669 |
| Continuation | Dollar-neutral | Large  | Aligned     |    8 |    −$708 |    −$807 |
| Continuation | Dollar-neutral | Large  | Opposed     |    2 |    −$588 |    −$490 |
| Continuation | Long-only      | Medium | Aligned     |  151 | −$12,238 |  −$9,979 |
| Continuation | Long-only      | Medium | Opposed     |  154 |  −$6,265 |  −$6,352 |
| Continuation | Long-only      | Large  | Aligned     |   54 |  −$9,507 |  −$8,032 |
| Continuation | Long-only      | Large  | Opposed     |   44 |      $39 |    −$549 |

## Walk-forward stability at 5 bp

The same causal rules run each year; only lagged features, permitted liquidity elections, and the
expanding DSR reference change. The selected rows below are descriptive; no strategy was picked on
Holdout. The 60m fade earned **−$163 Train**, **−$712 Validation**, and **+$1,141 Holdout**, for only
**+$267** over the full measured calendar before any unmodeled costs. The XLK lift was positive in 2024
and 2025 but not in partial 2026.

| Year                 | B0 inverse vol | B0 + XLK inverse vol | 60m medium aligned neutral fade |
| -------------------- | -------------: | -------------------: | ------------------------------: |
| 2016                 |          −$277 |                 $403 |                           −$419 |
| 2017                 |          −$629 |                −$643 |                            $756 |
| 2018                 |        $10,211 |              $11,253 |                            $938 |
| 2019                 |        −$5,603 |              −$5,770 |                            $627 |
| 2020                 |         $2,624 |                −$215 |                         −$1,539 |
| 2021                 |         $8,859 |               $9,550 |                           −$526 |
| 2022                 |        $17,899 |              $19,107 |                           −$585 |
| 2023                 |         $5,447 |               $6,463 |                           −$127 |
| 2024                 |         $7,371 |               $9,157 |                            $461 |
| 2025                 |         $9,808 |              $10,364 |                            $413 |
| 2026 (through 11/25) |        $14,449 |              $14,079 |                            $267 |

## Reproduction

From the repository root in the [archived checkout][study-revision], with existing read-only access to the `agents-artifacts` archive:

```sh
scratch="$(mktemp -d)"
bun services/bayn/tools/research-sector-etf-intraday-expansion.ts --output "$scratch/results.json"
bunx oxfmt --config .oxfmtrc.json "$scratch/results.json"
cmp "$scratch/results.json" docs/bayn/evidence/2026-11-27-sector-etf-intraday-expansion/results.json
rm -rf "$scratch"
```

The command validates archive identity and refuses to overwrite an output. Nothing in this study changes
runtime strategy, broker or capital authority, or activation of `bayn.intraday-alpha-policy.v3`.

[archived-results]: https://github.com/proompteng/lab/blob/4b25eaee338c3c4766360108733da2f266dff493/docs/bayn/evidence/2026-11-27-sector-etf-intraday-expansion/results.json
[study-revision]: https://github.com/proompteng/lab/tree/4b25eaee338c3c4766360108733da2f266dff493
