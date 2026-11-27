# Bayn Wave 2B — three-year SIP audit (2026-11-27)

**Unqualified, bar-based research.** No live policy, runtime primitive, or migration is changed. The live v2 protocol hash
remains `5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d`.

## Answers

1. **Live v2: the SIP replay does not establish live profitability.** At the primary post-decision open (t+2) and
   5 bp round trip, the proxy returned **$2,163** overall and **−$1,943** on Frozen Holdout.
   It had **3/6** positive half-years, with Ex-Top-5 of **−$9,885** overall and **−$9,362** on Holdout.
   The full-sample Sharpe was **0.08**, bootstrap p-value **0.436**, and LOSO without WDC left **−$6,098**.
2. **Wave 1E: wider limits are not equivalent to higher P&L.** The 25/50 and 35/50 bp combinations changed primary
   Holdout net by **−$4,535** and **+$1,463**.
   At the live collar, widening the stop buffer from 10 to 50 bp changed the full-window blocked-stop count from
   **29 to 4**, not zero. Midday four-leg completion rose from **33.4%** to **82.1–94.5%** across the two
   wider upgrades, but both worsened full-sample Ex-Top-5. The 35/50 case lost **$8,193** relative to live
   on Holdout at 10 bp, despite its 5 bp improvement.
3. **v3: no design meets the full chronological gate.**
   The development receipt selected `MIDDAY+NOISE-fixed-2pair-eod` (0/116 designs passed
   development). At the primary clock/cost it scored **$1,640** on Holdout (**−$5,458** after
   removing the top five days) and had **5/6** positive calendar half-years.

## Data admission

- **6,491,892** rows match both SHA-256 receipts. The exchange calendar admits
  **5,820,222** RTH rows and excludes **671,670** off-session rows.
  The replay retains **729** sessions, including **6** 13:00 ET closes.
- The minute grid has **18,948** no-bar slots after first availability. SPY has **0**; the largest counts are
  LITE (10,429), SNDK (3,331), and COHR (2,349). All slots reconcile with the provider's separately frozen five-minute
  bars (see below). A SIP bar requires valid OHLC and positive volume; not every clock minute produces one. No prices
  were fabricated.
- SNDK first appears in RTH on **2025-02-13**, and is first eligible
  **2025-03-10** after 14 usable prior sessions (at least 200 RTH bars each).
  The initial **5** sessions have no trailing baseline.
- NVDA closes at **$120.87 on June 7** and opens at **$120.35 on June 10, 2024**.
  There is no 10:1 price discontinuity at the split in this object; no manual rescaling was applied.

### Independent check for omitted minute bars

A read-only check verified the compressed and raw manifest digests of the separately frozen
`alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz` in the same S3 prefix. Its raw SHA-256 is
`c053ede2875ad791c99aae517db9efa9a4587b08c9907d55e0960dade59d567e` (3,923,737 total rows).
No five-minute prices were used by the simulator or in the development freeze.

[Alpaca builds its five-minute bars](https://docs.alpaca.markets/us/v1.4.2/docs/market-data-faq#how-are-bars-aggregated)
from its minute bars. Restrict both objects to the same symbols, calendar bounds, and first available dates. Within
each five-minute bin, take the open/close from the first/last observed minute, the max high, the min low, and sum volume.
Compare all five fields exactly against the five-minute export; an empty minute bin must also have no five-minute bar.

- **1,167,834/1,167,834** expected RTH five-minute bins reconcile exactly. This includes **14,291** bins with
  one or more no-bar slots, accounting for **all 18,948** slots; **102** of these bins have neither a minute nor a
  five-minute bar. No five-minute data precede the first minute-bar date.
- A direct SIP query of 2024-01-02 14:30–14:47 UTC also reproduced the LITE omissions at 14:31, 14:32, 14:39,
  14:43, and 14:46 UTC, and the COHR omission at 14:35 UTC.

This corroborates completeness relative to the frozen provider aggregation, not a bar on every clock minute, venue-level
trade completeness, or historical NBBO execution.

See [results.json](results.json) for the full engine, portfolio, execution and coverage matrices, and
[freeze.json](freeze.json) for the development-only design ranking and bindings. No raw data is committed.

## Live v2: 10 bp entry / 10 bp stop limit

P&L is net USD. Sleeves are attributed inside the concurrent run. The JSON includes per-engine and portfolio metrics
for each cost/clock pair, each chronological stage, all six calendar half-years, and the full sample.

| Case     | ORB      | Midday   | Noise   | Portfolio | Sharpe | MaxDD   | Calmar | PF   | BE bp | Ex-5     | Ex-10    | LOSO         | p      | 4-leg | Blocks |
| -------- | -------- | -------- | ------- | --------- | ------ | ------- | ------ | ---- | ----- | -------- | -------- | ------------ | ------ | ----- | ------ |
| t+1/2bp  | $1,549   | $9,213   | $18,334 | $29,096   | 0.88   | $12,124 | 0.83   | 1.07 | 5.23  | $12,625  | $2,937   | WDC $12,561  | 0.0616 | 89.4% | 37     |
| t+1/5bp  | −$4,682  | −$5,794  | $13,184 | $2,708    | 0.08   | $14,828 | 0.06   | 1.01 | 5.30  | −$13,555 | −$23,044 | WDC −$13,870 | 0.4458 | 85.6% | 38     |
| t+1/10bp | −$12,975 | −$35,562 | $5,831  | −$42,706  | -1.36  | $49,674 | -0.30  | 0.90 | 5.11  | −$58,223 | −$67,300 | WDC −$57,248 | 0.9910 | 75.7% | 51     |
| t+2/2bp  | $6,501   | $12,401  | $10,694 | $29,595   | 1.02   | $9,827  | 1.04   | 1.09 | 6.00  | $14,553  | $6,969   | WDC $20,583  | 0.0334 | 39.6% | 28     |
| t+2/5bp  | $2,540   | −$3,595  | $3,218  | $2,163    | 0.08   | $12,455 | 0.06   | 1.01 | 5.31  | −$9,885  | −$17,214 | WDC −$6,098  | 0.4359 | 33.4% | 29     |
| t+2/10bp | −$7,323  | −$19,786 | −$4,626 | −$31,735  | -1.24  | $37,040 | -0.30  | 0.90 | 5.02  | −$42,571 | −$49,562 | WDC −$38,481 | 0.9850 | 22.4% | 39     |

## Live v2: chronological and half-year panels, t+2 / 5 bp

| Period     | Sessions | ORB     | Midday  | Noise   | Portfolio | Sharpe | Ex-5     | Ex-10    | 4-leg | Blocks |
| ---------- | -------- | ------- | ------- | ------- | --------- | ------ | -------- | -------- | ----- | ------ |
| all        | 729      | $2,540  | −$3,595 | $3,218  | $2,163    | 0.08   | −$9,885  | −$17,214 | 33.4% | 29     |
| train      | 374      | $3,505  | −$7,863 | $5,279  | $920      | 0.07   | −$10,255 | −$15,411 | 35.6% | 14     |
| validation | 189      | $962    | $3,846  | −$1,623 | $3,186    | 0.42   | −$4,285  | −$10,359 | 29.7% | 9      |
| holdout    | 166      | −$1,927 | $422    | −$438   | −$1,943   | -0.29  | −$9,362  | −$15,180 | 32.9% | 6      |
| 2024H1     | 124      | −$1,062 | −$620   | $1,424  | −$259     | -0.08  | −$5,651  | −$8,612  | 31.9% | 3      |
| 2024H2     | 128      | $5,174  | −$4,940 | $2,375  | $2,609    | 0.65   | −$2,926  | −$7,295  | 42.6% | 7      |
| 2025H1     | 122      | −$606   | −$2,303 | $1,479  | −$1,430   | -0.27  | −$11,240 | −$15,021 | 31.9% | 4      |
| 2025H2     | 128      | $1,065  | $5,320  | −$2,176 | $4,209    | 0.91   | −$2,269  | −$7,287  | 28.0% | 5      |
| 2026H1     | 123      | −$2,760 | −$3,177 | $818    | −$5,118   | -0.92  | −$12,778 | −$18,436 | 28.9% | 7      |
| 2026H2     | 104      | $729    | $2,125  | −$703   | $2,152    | 0.54   | −$4,618  | −$10,069 | 37.9% | 3      |

## Wave 1E: fixed-alpha execution comparisons

The JSON covers all 90 execution scenarios (15 collar/stop combinations × six cost/clock pairs). Changes below are
against the corresponding v2 case. A blocked stop is a distinct trade with at least one blocked minute; the JSON also
retains the minute count.

| Period, t+2/5 bp | 25/50 Δ net | 35/50 Δ net | 25/50 Δ Sharpe | 35/50 Δ Sharpe | 25/50 Δ Ex-5 | 35/50 Δ Ex-5 | 4-leg v2/25/35         | Blocks v2/25/35 |
| ---------------- | ----------- | ----------- | -------------- | -------------- | ------------ | ------------ | ---------------------- | --------------- |
| all              | −$6,193     | +$1,109     | -0.21          | +0.02          | −$9,370      | −$2,273      | 33.4% / 82.1% / 94.5%  | 29 / 4 / 4      |
| train            | +$941       | +$459       | +0.05          | +0.02          | −$2,840      | −$2,298      | 35.6% / 85.8% / 97.2%  | 14 / 1 / 1      |
| validation       | −$2,598     | −$813       | -0.35          | -0.16          | −$2,751      | −$2,347      | 29.7% / 75.7% / 91.4%  | 9 / 2 / 2       |
| holdout          | −$4,535     | +$1,463     | -0.61          | +0.23          | −$4,355      | −$300        | 32.9% / 81.1% / 92.1%  | 6 / 1 / 1       |
| 2024H1           | −$3,034     | −$3,098     | -0.86          | -0.85          | −$3,376      | −$4,080      | 31.9% / 84.9% / 96.6%  | 3 / 0 / 0       |
| 2024H2           | −$533       | −$1,655     | -0.20          | -0.45          | −$1,890      | −$2,703      | 42.6% / 92.6% / 100.0% | 7 / 0 / 0       |
| 2025H1           | +$4,507     | +$5,211     | +0.71          | +0.83          | +$939        | +$1,919      | 31.9% / 79.8% / 95.0%  | 4 / 1 / 1       |
| 2025H2           | −$3,049     | −$2,389     | -0.70          | -0.59          | −$3,547      | −$3,517      | 28.0% / 78.4% / 90.4%  | 5 / 0 / 0       |
| 2026H1           | −$2,619     | −$178       | -0.33          | +0.13          | −$2,902      | −$2,131      | 28.9% / 75.2% / 95.9%  | 7 / 3 / 3       |
| 2026H2           | −$1,466     | +$3,217     | -0.37          | +0.68          | −$665        | +$2,464      | 37.9% / 81.6% / 88.3%  | 3 / 0 / 0       |

### Frozen Holdout net change by clock and cost

| Case     | 10/50 stop only | 20/50   | 25/50    | 35/50   |
| -------- | --------------- | ------- | -------- | ------- |
| t+1/2bp  | −$563           | −$850   | −$850    | −$850   |
| t+1/5bp  | −$613           | −$2,727 | −$2,727  | −$2,727 |
| t+1/10bp | −$729           | −$1,413 | −$1,413  | −$1,413 |
| t+2/2bp  | −$433           | −$6,390 | −$4,663  | +$648   |
| t+2/5bp  | −$470           | −$4,130 | −$4,535  | +$1,463 |
| t+2/10bp | −$561           | −$8,347 | −$11,292 | −$8,193 |

## Frozen architecture

The nominee prunes Morning ORB, retains Midday and Noise Area with fixed weights, keeps two Midday pairs and replaces
Midday's brackets with its scheduled close. It uses a **25 bp** entry collar and **50 bp** stop buffer (the latter still
applies to Noise Area).
Gate outcomes: development **fail**, Holdout **fail**, and higher primary net than v2 in
every chronological epoch **fail**. Only this design and the predeclared execution grid were scored on
Holdout. The study uses today's live symbol list retrospectively, not an ex ante point-in-time universe.

| Period     | 5 bp net | 5 bp Ex-5 | 5 bp Sharpe | 10 bp net | 10 bp Ex-5 | 10 bp Sharpe |
| ---------- | -------- | --------- | ----------- | --------- | ---------- | ------------ |
| all        | $13,087  | −$5,628   | 0.41        | −$18,911  | −$37,806   | -0.59        |
| train      | $9,142   | −$9,107   | 0.51        | −$6,994   | −$24,699   | -0.39        |
| validation | $2,305   | −$4,976   | 0.30        | −$5,703   | −$12,766   | -0.74        |
| holdout    | $1,640   | −$5,458   | 0.25        | −$6,214   | −$14,003   | -0.91        |
| 2024H1     | $721     | −$3,837   | 0.24        | −$4,781   | −$9,104    | -1.60        |
| 2024H2     | −$613    | −$7,213   | -0.16       | −$6,233   | −$12,029   | -1.71        |
| 2025H1     | $9,034   | −$8,266   | 1.00        | $4,020    | −$13,023   | 0.44         |
| 2025H2     | $481     | −$6,395   | 0.10        | −$4,993   | −$11,616   | -1.04        |
| 2026H1     | $2,784   | −$4,385   | 0.52        | −$2,827   | −$9,741    | -0.52        |
| 2026H2     | $680     | −$5,561   | 0.17        | −$4,097   | −$11,043   | -0.97        |

### Development-only sleeve, sizing, pair, and bracket comparisons

All rows use the 25/50 bp execution anchor and the primary clock/cost. The full 116-design matrix, including
the other sleeve combinations and cases, is in the original [freeze.json](freeze.json). Review found that the
three-pair implementation could pick the alphabetically first remaining legs instead of the third-ranked pair.
The fix and [development-only correction receipt](development-correction.json) supersede the 16 three-pair rows.
The other 100 designs reproduced exactly; the nominee and its failed development gate did not change. The
one-time holdout score ran only two-pair designs, so it was not regenerated.

| Variant                                     | Train net | Train Ex-5 | Validation net | Validation Ex-5 |
| ------------------------------------------- | --------- | ---------- | -------------- | --------------- |
| Three sleeves / fixed two-pair live bracket | $1,861    | −$13,095   | $587           | −$7,037         |
| Morning ORB only                            | −$17      | −$5,008    | −$2,807        | −$7,446         |
| Midday only                                 | −$4,452   | −$12,657   | $1,379         | −$5,836         |
| Noise Area only                             | $7,406    | −$2,710    | −$114          | −$3,879         |
| Midday + Noise, fixed/live                  | $2,955    | −$11,718   | $1,264         | −$6,017         |
| Midday + Noise, dispersion                  | $5,965    | −$7,043    | −$1,926        | −$8,614         |
| Midday + Noise, volatility                  | −$1,983   | −$12,716   | $441           | −$7,013         |
| Midday + Noise, both                        | $10,089   | −$128      | −$252          | −$8,137         |
| Midday + Noise, 3L+3S                       | $6,769    | −$6,168    | −$4,104        | −$9,986         |
| Midday + Noise, symmetric 300 bp            | −$1,823   | −$13,745   | −$3,965        | −$10,924        |
| Midday + Noise, symmetric 500 bp            | $254      | −$12,512   | $590           | −$6,479         |
| Midday + Noise, symmetric 800 bp            | $4,799    | −$9,702    | $2,227         | −$5,054         |
| Midday + Noise, timed only (frozen)         | $9,142    | −$9,107    | $2,305         | −$4,976         |

## Protocol

The [Alpaca historical bars contract](https://docs.alpaca.markets/us/reference/stockbars) describes the archived `feed=sip`
and `adjustment=split` settings. The CLI verifies both compressed and decompressed SHA-256 and byte counts. A
[SIP minute bar](https://alpaca.markets/learn/stock-minute-bars) is derived from eligible trades; a missing bar is not by
itself proof of a data-delivery failure, nor is it an executable price.

- **Signal and capital.** Use the archived calendar's 09:30–16:00 ET regular session or 13:00 ET early close. SPY is a
  benchmark, not a traded 21st symbol. The 18 equity candidates and QQQ/SMH keep production extraction, selection, funded
  whole-share brackets, and target planning. Use synthetic quote, account, and borrow liveness; this does not establish
  actual broker eligibility, fill depth, queue priority, financing costs, or arrival times. The pre-July 2026 funding
  check uses the retained fee schedule only to construct valid plans; modeled P&L always uses the 0.21 bp sell fee.
  Use fixed $100,000 planning equity and a shared $180,000 gross cap, not compounding. At decisions, value co-held positions
  at the greater of mark and entry price; reserve the greater of the adverse planner reference and entry limit, then check
  fill notional again. This is not continuous mark-to-market risk enforcement. Unfilled committed intents consume their
  live quotas. Midday legs fill independently; the planner's neutrality does not guarantee a neutral filled basket.
- **Execution.** `t+1` is the adjacent open and can predate the decision at `t+1:02`. `t+2` is the first full post-decision
  open. Apply half of the 2/5/10 bp round-trip stress on each adverse executable side and 0.21 bp on sell notional.
  Limit exits cannot slip through their bound; stops take priority on a both-touch minute and stay working after activation
  if no ordered executable price clears the limit. Timed exits use the first observed RTH open strictly after the deadline;
  an absent exact entry open cannot fill. Open-position gaps and unresolved exits have separate counts.
- **Execution grid.** Change only the admission collar and stop-limit buffer. Keep v2 shares, stop trigger and profit
  target fixed across the grid, as in [Wave 1E](https://github.com/proompteng/lab/pull/16356). Coupling a wider collar to a
  new funded size or bracket is a different experiment.
- **Ablations.** At 25/50 bp, test every nonempty sleeve subset with fixed or volatility sizing. When Midday is active,
  also test dispersion sizing and both sizing rules together. The [Nagel](https://www.nber.org/papers/w17653)-inspired
  proxy scales Midday by the sample standard deviation of eligible, contemporaneous relative VWAP signals divided by
  100 bp, clipped to 0.5–1.5. The [Moreira–Muir](https://www.nber.org/papers/w22208)-inspired variant uses a fixed 15%
  volatility target divided by annualized volatility of the prior 14 SPY close-to-close returns, also clipped to
  0.5–1.5. This is a volatility-targeting adaptation, not the paper's inverse-variance estimator. Combined sizing
  multiplies both factors for Midday with the same symbol cap. Compare fully sign-gated 3L+3S at the same 72% gross
  target (12% per leg), plus symmetric 300/500/800 bp brackets and timed-only exits at two pairs. Pair count and bracket
  change one at a time.
- **Chronology.** Freeze on Train (2024-01-02–2025-06-30) and Validation (2025-07-01–2026-03-31) only. A development pass
  needs positive net and Ex-Top-5 net in both stages at `t+2`, at both 5 and 10 bp. Rank by the lesser primary
  (`t+2`, 5 bp) Train and Validation Sharpe, then Validation Ex-Top-5, then ID. If none pass, freeze the best diagnostic
  design by the same rank. Score the predeclared execution grid and only that architecture on 2026-04-01–2026-11-25.
  An economic pass also needs the same two-cost Holdout gate, positive primary net in at least five calendar half-years,
  and higher primary net than v2 in every chronological stage. 2026H1 mixes Validation and Holdout and is descriptive. Wave 1E's 66 IEX research sessions
  (2026-08-25–2026-11-25) overlap this Holdout and informed the execution hypothesis. The freeze prevents tuning on
  the SIP Holdout; it does not make the Wave 1E hypothesis test fully independent in calendar time.
- **Metrics.** Report daily closed P&L, including zero-trade days, at 252 annual sessions. Drawdown is from the
  cumulative closed-P&L peak; Calmar divides annualized arithmetic P&L by max drawdown. Profit factor uses winning
  and losing trades after costs. The fixed-path linear breakeven estimate does not assert identical fills at another
  stress. Ex-Top-5/10 removes the five/ten highest daily contributions per panel. LOSO reruns v2 after withholding
  each tradable symbol before selection and funding (SPY stays as benchmark); fixed-trade worst-symbol attribution
  is also recorded but does not replace reruns. The one-sided 10,000-trial p-value resamples mean-centered daily P&L
  in seeded circular 5-day blocks, truncating the last block to preserve sample length. These p-values are descriptive
  and not adjusted for multiple experiments.

## Reproduction

Use exact [freeze commit `391406f88`](https://github.com/proompteng/lab/commit/391406f88) in a clean checkout with the
read-only Agents artifacts S3 endpoint and credentials. Scoring intentionally refuses a different source tree,
including a later PR head that incorporates intervening changes on `main`.

```sh
bun services/bayn/tools/research-3yr-sip-bayn21-v2.ts --freeze --output /tmp/bayn-freeze-reproduction.json
bunx oxfmt --write /tmp/bayn-freeze-reproduction.json
cmp /tmp/bayn-freeze-reproduction.json docs/bayn/evidence/2026-11-27-3yr-sip-bayn21-v2/freeze.json
```

Scoring requires the committed development receipt and refuses to overwrite evidence. The retained score was produced
once after [freeze commit `391406f88`](https://github.com/proompteng/lab/commit/391406f88). The score binds the
SHA-256 of that committed receipt and refuses changed inputs or research code:

```sh
bun services/bayn/tools/research-3yr-sip-bayn21-v2.ts --score
bunx oxfmt --write docs/bayn/evidence/2026-11-27-3yr-sip-bayn21-v2/results.json
```
