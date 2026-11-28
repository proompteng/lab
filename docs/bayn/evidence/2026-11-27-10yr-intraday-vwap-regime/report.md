# Wave 19S: ten-year OOS intraday VWAP and volatility regimes

**DO NOT PROMOTE.** The B0 opening-range filter improved 5 bp Sharpe from **0.847 to 0.920** and reduced
maximum drawdown from **9.12% to 8.14%**, but earned less net P&L and failed the multiple-trial inference
gate. VWAP confirmation helped less. The fully priced VWAP fades had low daily correlation with B0 but
lost money even at 0 bp slippage. None improved the Sharpe of a 50/50 blend with B0. Keep B0 as the
research control; this verdict does not change any live strategy or capital authority.

## Sample and execution

- **2,513 official sessions, 2016-11-28 through 2026-11-25.** The ten-year window is
  `(2016-11-25, 2026-11-25]` and includes 20 early closes. The 228 preceding official sessions provide
  initial history, not OOS returns. Each annual fold uses a new expanding training cut ending before
  that fold's first session. The same dates were used in earlier Bayn research; this is historical
  walk-forward OOS for these rules, not a previously unseen or prospective test.
- **Data:** the [Wave 6A](../2026-11-27-10yr-16etf-noise-area/README.md) split-adjusted consolidated
  Alpaca SIP five-minute tapes. The runner verifies pinned manifests and calendars, gzip receipts, row
  counts, order and symbol coverage. It reads 8,641,719 development and 3,923,737 continuity rows
  before regular-hours filtering. QQQ, SMH, XLK, SPY and IWM are present in every official session.
  The full source-window B0 replay reproduces Wave 6A to the cent: **$103,533.58 at 2 bp** and
  **$69,780.16 at 5 bp**. These parity values include warmup dates and are not the OOS table below.
- **Clock:** only completed bars inform a decision; entries and signal-driven exits first target the
  following open on the five-minute grid. A missing entry open cancels the entry. All priced legs
  are flat by **15:50 ET** (**12:50 ET** on early closes), and a price after the deadline never
  resolves an exit. When a fade encounters a missing held bar it requests an exit at the next available
  open by the deadline and records the gap. No data is filled forward or inferred.
- **Costs:** fixed $100,000 reference, no compounding or idle-cash yield. Each side pays half the
  quoted round-trip slippage on its traded notional, plus the retained 0.21 bp charge on the adjusted
  sell notional. The 0 bp column removes slippage, not the sell fee. Breakeven is the signed root of
  net P&L vs round-trip slippage; a negative root means no nonnegative cost breaks even. Drawdown
  uses the peak of starting capital plus cumulative net P&L, with no modeled margin or insolvency
  liquidation. Split-adjusted historical bar opens do not prove point-in-time data availability,
  executable size, bid/ask spreads, borrow, latency or market impact.

## Registered comparison

The rules, trial set and decision gates were committed locally in
[`056922ef2`](https://github.com/proompteng/lab/commit/056922ef21ae9ec9265ad35b8dd4a81698aab10e)
before opening the price tapes. There was no subsequent parameter or gate change.

- **B0 and NA5 controls:** Wave 6A's 30-minute, 1.4× gap-aware Noise Area, opposite-band exit and
  inverse-volatility sizing, on QQQ/SMH and all five ETFs respectively. Retain the preallocated
  dollar budgets and whole-share fill sizing, which caps shares at the signal-close and adverse-open budget.
- **Four first-trade filters per control:** keep the original side, time and allocation only if the first
  signal is directionally past cumulative VWAP, directionally outside the 09:30–09:45 range, in a low-RV
  regime, or in a high-RV regime, respectively. A rejected leg is not re-entered or reallocated.
- **Six VWAP fades:** on the same 30-minute checkpoints from 10:00 (through 15:00 regular or 12:30 early),
  fade a close at least half the 15-minute opening-range width from cumulative VWAP. Test unrestricted vs
  inside the opening range, crossed with any, low or high RV. VWAP uses provider bar VWAP times volume from
  the session open. Each ETF has one fixed one-fifth budget and at most one trade per day; shares are fixed
  at the signal close. Exit on the first completed-bar VWAP cross, after 60 minutes, or at the session
  deadline, whichever comes first.
- **Six equal-funded blends:** half B0 daily P&L plus half a fade's daily P&L on the same dates. This is a
  return blend, not shared-account fill, symbol netting, or buying-power evidence.

Per ETF, daily realized variance is the mean squared intraday five-minute log return, starting with the
first bar's open-to-close return and excluding the overnight gap. The regime feature is the square
root of mean variance over the **20 previous complete official sessions**; any missing bar in those
20 sessions withholds the gate, not a substitute day. Each annual fold fits a median from all preceding
available trailing features and holds it fixed during the fold. A value at the median is low RV.

## Full-decade cost and risk

Returns are cumulative net P&L as a percentage of fixed starting capital, not annualized returns.
Sharpe is annualized over all official sessions (including zero-trade days). Sharpe, drawdown and
Pearson daily return correlation with B0 are at **5 bp**. Complete non-headline variants, blends and
all cost-level statistics are in [results.json](results.json).

| Book                     | Net 0 bp | Net 2.5 bp | Net 5 bp | Net 10 bp | Sharpe |  MaxDD | Breakeven bp | Daily r vs B0 |
| ------------------------ | -------: | ---------: | -------: | --------: | -----: | -----: | -----------: | ------------: |
| B0                       |  125.04% |     99.27% |   73.50% |    21.97% |  0.847 |  9.12% |        12.13 |         1.000 |
| B0/VWAP-aligned          |  124.83% |     99.26% |   73.70% |    22.57% |  0.858 |  8.11% |        12.21 |         0.992 |
| B0/opening-break         |  118.30% |     95.06% |   71.82% |    25.35% |  0.920 |  8.14% |        12.73 |         0.934 |
| B0/low RV                |   17.47% |     10.09% |    2.72% |   −12.04% |  0.100 |  5.49% |         5.92 |         0.351 |
| B0/high RV               |  102.69% |     84.52% |   66.36% |    30.02% |  0.821 |  9.58% |        14.13 |         0.944 |
| NA5/low RV               |   14.42% |      5.42% |   −3.58% |   −21.57% | −0.171 |  7.58% |         4.01 |         0.365 |
| Fade/unrestricted/low RV |  −12.67% |    −28.82% |  −44.97% |   −77.27% | −2.962 | 45.03% |        −1.96 |        −0.093 |
| Fade/inside/any RV       |   −4.58% |    −20.46% |  −36.33% |   −68.08% | −1.857 | 37.14% |        −0.72 |         0.129 |
| Fade/inside/low RV       |   −0.74% |     −5.19% |   −9.64% |   −18.53% | −1.747 |  9.83% |        −0.42 |         0.070 |
| Fade/inside/high RV      |   −0.58% |    −11.79% |  −23.00% |   −45.42% | −1.331 | 24.03% |        −0.13 |         0.137 |
| B0 + Fade/inside/low RV  |   62.15% |     47.04% |   31.93% |     1.72% |  0.732 |  5.08% |        10.28 |         0.998 |

High RV did make B0 more cost-tolerant at 10 bp, but it lowered Sharpe and increased drawdown at the
primary 5 bp cost. Low RV reduced drawdown partly by taking fewer trades (541 vs 2,045 B0 round trips),
but failed 10 bp stress. The best fully priced blend by 5 bp Sharpe still trailed B0. A 50% allocation to
B0 plus zero-return cash would preserve B0's Sharpe, so a smaller drawdown from the blend alone is not
evidence that the fade improves risk-adjusted returns.

### Missing prints: keep incomplete windows incomplete

On **2019-08-12**, the archive does not prove one timely exit for NA5 and its VWAP, opening-break and
high-RV variants. It also does not prove two timely exits for the unrestricted fade and its high-RV variant
(and thus their blends). For these books the decade and affected annual fold have **null** risk and P&L
metrics, not zeros. No qualifying path uses a late print. The B0 OOS control has no held gaps or
unresolved exits.

The post-score `commonResolved` sensitivity removes this one date from **every** book (2,512 sessions);
it does not repair the archive or affect inference or promotion. On that matched subset, the 5 bp
NA5 control earned **26.95%**, Sharpe **0.390**, versus B0 **73.50%**, Sharpe **0.848**. NA5/high RV
improved to **32.03%**, Sharpe **0.505**, but still trailed B0 and lost **2.22%** at 10 bp. Both NA5
price confirmations reduced drawdown but also reduced 5 bp Sharpe vs NA5. Even before slippage the
unrestricted fade lost **24.83%**; its 5 bp correlation was **−0.216**, but its blend with B0 lost **32.41%**.
The unrestricted high-RV fade also lost net at 0 bp (**−13.46%**).

## Walk-forward stability

Each cell is **5 bp net return / annualized Sharpe**. The table shows the two confirmations, B0's high-RV
stress alternative, and the best fully priced blend at 5 bp. [All ten folds and four costs for every
book](results.json) retain the fitting cutoffs and exact session bounds.

| Fold ends  | Sessions |             B0 | B0/VWAP-aligned | B0/opening-break |     B0/high RV | B0 + Fade/inside/low RV |
| ---------- | -------: | -------------: | --------------: | ---------------: | -------------: | ----------------------: |
| 2017-11-24 |      251 |   2.38% / 0.44 |    2.41% / 0.44 |     2.99% / 0.59 |   4.66% / 1.77 |          −0.40% / −0.14 |
| 2018-11-23 |      251 |   7.85% / 0.94 |    6.21% / 0.75 |     9.53% / 1.23 |   6.38% / 0.79 |            3.77% / 0.90 |
| 2019-11-25 |      252 | −3.29% / −0.45 |  −2.93% / −0.40 |   −1.24% / −0.18 | −1.34% / −0.20 |          −2.26% / −0.60 |
| 2020-11-25 |      253 |   5.25% / 0.66 |    6.85% / 0.89 |     5.19% / 0.73 | −0.88% / −0.12 |            2.57% / 0.65 |
| 2021-11-24 |      251 |   3.41% / 0.44 |    3.79% / 0.53 |     2.31% / 0.34 |   1.08% / 0.14 |            1.45% / 0.37 |
| 2022-11-25 |      252 |  15.89% / 1.32 |   15.89% / 1.32 |    18.53% / 1.58 |  15.89% / 1.32 |            7.94% / 1.32 |
| 2023-11-24 |      250 |  13.15% / 1.49 |   13.17% / 1.49 |    10.99% / 1.33 |   8.96% / 1.08 |            6.31% / 1.42 |
| 2024-11-25 |      252 |   1.74% / 0.25 |    1.74% / 0.25 |     2.79% / 0.47 |   4.28% / 0.83 |            0.14% / 0.04 |
| 2025-11-25 |      250 |  12.35% / 1.05 |   11.78% / 1.01 |     6.62% / 0.80 |  12.89% / 1.15 |            5.37% / 0.91 |
| 2026-11-25 |      251 |  14.78% / 1.74 |   14.78% / 1.74 |    14.09% / 1.68 |  14.45% / 1.86 |            7.03% / 1.64 |

Opening-break raised Sharpe in **6/10** folds; VWAP in **5/10**. Each was positive in the same nine
folds as B0 and still lost money in the fold ending November 2019. The inside/low-RV fade had no positive
5 bp year despite its near-zero correlation, and no trades in the fold ending November 2022.

## Inference and promotion

The [stationary block bootstrap](https://doi.org/10.1080/01621459.1994.10476870) uses 10,000 seeded draws
of centered circular blocks averaging five official sessions (one-sided, plus-one p-value). At 5 bp, standalone
positive-mean p-values are **0.0020** for B0, **0.0013** for VWAP-aligned, and **0.0010** for opening-break.
The paired mean-improvement p-values vs B0 are **0.4612** and **0.5873** for VWAP-aligned and
opening-break, respectively. Neither provides evidence of higher mean daily net return. The four complete
standalone fades all had **p = 1.0000** against zero at 5 bp.

The [Deflated Sharpe Ratio](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf) counts exactly **80**
registered trials: (8 Noise Area filters + 6 fades + 6 blends) × 4 costs. Exclude the two fixed controls,
and do not count repeated annual folds as extra trials. Estimate dispersion from the **52** finite
unannualized trial Sharpes and use all 80 for the expected-maximum multiplier; do not impute Sharpes for
unresolved paths. The pooled hurdle is **0.21779 daily Sharpe**, reflecting the large spread between
these rules and costs. At 5 bp, DSR is **7.30 × 10⁻¹⁸** for VWAP-aligned and **4.23 × 10⁻¹⁶** for
opening-break. The count treats related trials as separate and does not account for the wider Bayn
research program.

Promotion required timely resolved execution with no held gaps, positive 10 bp net, and at 5 bp at least
seven positive folds, positive net, bootstrap p < 0.05 and DSR ≥ 0.95. A replacement also needed higher
Sharpe and lower drawdown than B0 and its matched control. A companion needed absolute standalone
correlation < 0.30 and higher Sharpe and lower drawdown for its 50/50 blend vs B0. No candidate passed.

## Reproduce

Run from the repository root in the [archived checkout][study-revision], with the pinned Bun toolchain and the existing read-only artifact credentials.
The command writes a new file only. Raw prices are not part of the committed evidence.

```sh
scratch=$(mktemp -d)
bun services/bayn/tools/research-10yr-intraday-vwap-regime.ts --output "$scratch/results.json"
bunx oxfmt --config .oxfmtrc.json "$scratch/results.json"
cmp "$scratch/results.json" docs/bayn/evidence/2026-11-27-10yr-intraday-vwap-regime/results.json
rm -- "$scratch/results.json"
rmdir -- "$scratch"
```

[study-revision]: https://github.com/proompteng/lab/tree/4b25eaee338c3c4766360108733da2f266dff493
