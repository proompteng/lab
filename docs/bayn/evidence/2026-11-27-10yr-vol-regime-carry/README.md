# Wave 5C: 10.9-year volatility-managed risk parity and macro carry

**Result: 55 of 62 configurations beat passive SHY with <4× annual one-way turnover in all three splits at
every cost. None qualified.** Across all 62 configurations, removing the ten best portfolio days turned
2022–2023 Validation excess negative even at 2 bp. The best such trimmed Validation result was **−0.21 pp**.
No strategy policy, capital authority, or deployment changes.

- **The credit/haven selector (F2) earned the largest excess among the four frozen representatives.** At 10 bp
  it beat SHY by **+66.32 / +16.91 / +61.34 pp** in Train / Validation / Holdout, with at most **2.20×/yr** and
  all 29 10 bp omissions positive in every split. Its 2022 return was **+1.14% vs SHY −3.88%**, but calendar-year
  drawdown reached **16.33%**. Validation Ex-Top-10 excess was **−8.38 pp**. Holdout beta to SPY was **0.48**;
  the SHY excess is not factor-adjusted alpha.
- **The fixed ensemble (F4) kept turnover below 0.91×/yr in each split.** At 10 bp its excess was
  **+34.36 / +7.77 / +26.46 pp** with Holdout p = **0.0072**, cumulative DSR **0.9562**, and wider-trial DSR
  **0.9473**. It still failed Validation Ex-Top-10 (**−0.29 pp**), the registered plateau (0/4), and
  Validation after omitting UUP (**−1.18 pp**).
- **Volatility scaling did not improve the matched 42-session risk-parity control on this tape.** At 10 bp
  the F1 inverse-variance representative had **1.23** full-period net Sharpe and **+55.08 pp** excess,
  versus **1.25** and **+57.39 pp** for the unscaled control, with the same **9.25%** full-period MaxDD.
  Their 2018 / 2020 / 2022 drawdowns were the same (**3.57% / 9.25% / 5.34%**). The F3 overlay modestly
  reduced 2018 drawdown to **3.43%**, but not 2020 or 2022, and returned **+52.61 pp** full-period excess.
  Removing UUP made Validation excess negative for the F1, F3 and F4 representatives.
- **This is retrospective.** Waves 3C and 4D already used the 2024–2026 ETF tape. Frozen selection,
  the stationary bootstrap, and cumulative DSR counting 375 audited ETF-relevant trials reduce specific
  sources of bias; they do not create independent evidence. Do not advance a strategy on this sample.

## Registration and sample

The [protocol](protocol.md) and runner were pushed in
[`a17abe4eb`](https://github.com/proompteng/lab/commit/a17abe4eb8e85a438a10caea4bd288ac2b24804a).
The [Train/Validation receipt](freeze.json) was pushed in
[`f38e5ce65`](https://github.com/proompteng/lab/commit/f38e5ce654d22e9119a1f0b2beb63e29a49dcccf)
and reproduced byte-for-byte **before** opening Holdout. [Results](results.json) bind that commit and
receipt digest. The matched, authenticated SIP total-return panel contains **2,741 sessions**, **29 ETFs
actually traded** including DIA and UUP, and no synthetic XLC or XLRE bars. The 2026 window ends November 25.
Train / Validation / Holdout have 1,511 / 501 / 729 sessions. Passive SHY returns were
**8.25% / 0.12% / 10.74%**, or **20.02%** over the full span.

The four representatives were locked using Train and Validation only:

| Family | Fixed representative                                             |
| ------ | ---------------------------------------------------------------- |
| F1     | 42-session review, inverse variance, RV20, 8% reference vol      |
| F2     | 42-session review, HYG/IEF primary, EMA100, 10-session smoothing |
| F3     | 42-session review, both RV ratios, 50% cut intensity             |
| F4     | 42-session review, inverse vol, HYG/LQD primary, 50/25/25 mix    |

## All four cost tiers

Each split cell shows **zero-idle net / SHY-idle net / SHY-idle excess (percentage points)**. Maximum split
turnover and inference are from the SHY-idle book. Return paths compound and carry holdings across
folds. The 0.21 bp sell fee is included; no strategy shorts or pays borrow.

| Frozen family leader |    RT |       Train: 0 / SHY / Δ |  Validation: 0 / SHY / Δ |     Holdout: 0 / SHY / Δ | Max split turnover | Holdout p / DSR |
| -------------------- | ----: | -----------------------: | -----------------------: | -----------------------: | -----------------: | --------------: |
| F1                   |  2 bp | 29.99% / 30.88% / +22.63 |    4.33% / 4.33% / +4.21 | 28.74% / 28.74% / +18.00 |              0.63× | 0.0159 / 0.9465 |
| F1                   |  5 bp | 29.91% / 30.73% / +22.49 |    4.32% / 4.32% / +4.20 | 28.71% / 28.71% / +17.96 |              0.63× | 0.0160 / 0.9456 |
| F1                   | 10 bp | 29.77% / 30.49% / +22.24 |    4.30% / 4.30% / +4.18 | 28.66% / 28.66% / +17.91 |              0.63× | 0.0165 / 0.9441 |
| F1                   | 20 bp | 29.49% / 30.00% / +21.75 |    4.27% / 4.27% / +4.14 | 28.56% / 28.56% / +17.81 |              0.63× | 0.0170 / 0.9406 |
| F2                   |  2 bp | 74.76% / 76.42% / +68.17 | 17.40% / 17.40% / +17.28 | 72.66% / 72.66% / +61.91 |              2.20× | 0.0103 / 0.9458 |
| F2                   |  5 bp | 74.12% / 75.72% / +67.47 | 17.26% / 17.26% / +17.14 | 72.44% / 72.44% / +61.70 |              2.20× | 0.0103 / 0.9448 |
| F2                   | 10 bp | 73.07% / 74.57% / +66.32 | 17.03% / 17.03% / +16.91 | 72.08% / 72.08% / +61.34 |              2.20× | 0.0105 / 0.9429 |
| F2                   | 20 bp | 70.97% / 72.28% / +64.04 | 16.57% / 16.57% / +16.45 | 71.37% / 71.37% / +60.62 |              2.20× | 0.0107 / 0.9387 |
| F3                   |  2 bp | 29.17% / 29.84% / +21.60 |    4.41% / 4.36% / +4.24 | 27.72% / 28.11% / +17.37 |              0.72× | 0.0109 / 0.9529 |
| F3                   |  5 bp | 29.08% / 29.69% / +21.44 |    4.39% / 4.33% / +4.21 | 27.67% / 28.03% / +17.29 |              0.72× | 0.0113 / 0.9515 |
| F3                   | 10 bp | 28.93% / 29.42% / +21.18 |    4.37% / 4.29% / +4.17 | 27.58% / 27.90% / +17.15 |              0.72× | 0.0120 / 0.9492 |
| F3                   | 20 bp | 28.63% / 28.90% / +20.65 |    4.31% / 4.21% / +4.09 | 27.41% / 27.63% / +16.89 |              0.72× | 0.0128 / 0.9439 |
| F4                   |  2 bp | 42.26% / 43.22% / +34.98 |    8.03% / 8.00% / +7.87 | 37.17% / 37.44% / +26.70 |              0.90× | 0.0065 / 0.9588 |
| F4                   |  5 bp | 42.08% / 42.99% / +34.74 |    7.99% / 7.96% / +7.84 | 37.09% / 37.35% / +26.61 |              0.90× | 0.0068 / 0.9579 |
| F4                   | 10 bp | 41.78% / 42.61% / +34.36 |    7.93% / 7.89% / +7.77 | 36.96% / 37.21% / +26.46 |              0.90× | 0.0072 / 0.9562 |
| F4                   | 20 bp | 41.20% / 41.84% / +33.59 |    7.81% / 7.76% / +7.64 | 36.70% / 36.92% / +26.18 |              0.90× | 0.0075 / 0.9525 |

## Split diagnostics at 10 bp

Metrics below are for the representatives' SHY-idle books; both books and all costs are in the ledger.
Down-SPY net compounds just the sessions where SPY was down and is not a continuously invested strategy.

| Family | Split      | Ex-top-5 net / Δ | Ex-top-10 net / Δ | Sharpe / excess Sharpe |  MaxDD | Calmar | One-way ×/yr | SPY beta | Down-SPY net / Δ |      p / DSR / wider DSR |
| ------ | ---------- | ---------------: | ----------------: | ---------------------: | -----: | -----: | -----------: | -------: | ---------------: | -----------------------: |
| F1     | Train      |  21.51% / +13.36 |    16.95% / +8.57 |            1.08 / 0.75 |  9.25% |   0.49 |         0.63 |     0.14 | -38.38% / -51.54 | 0.0186 / 0.8862 / 0.8608 |
| F1     | Validation |   -0.02% / +0.48 |    -3.15% / -1.85 |            0.52 / 0.52 |  5.34% |   0.40 |         0.18 |     0.09 | -17.00% / -14.39 | 0.1931 / 0.6618 / 0.6338 |
| F1     | Holdout    |  21.34% / +10.68 |    17.65% / +7.63 |            2.00 / 1.17 |  5.06% |   1.80 |         0.27 |     0.16 | -22.84% / -22.64 | 0.0165 / 0.9441 / 0.9332 |
| F2     | Train      |  46.31% / +38.09 |   31.83% / +23.92 |            0.87 / 0.75 | 19.21% |   0.51 |         2.20 |     0.36 | -84.46% / -97.62 | 0.0223 / 0.8993 / 0.8746 |
| F2     | Validation |    0.20% / +1.07 |   -10.58% / -8.38 |            0.60 / 0.61 | 16.33% |   0.50 |         1.99 |     0.61 | -72.88% / -70.26 | 0.1688 / 0.7087 / 0.6821 |
| F2     | Holdout    |  46.50% / +35.78 |   30.36% / +19.59 |            1.44 / 1.19 | 10.19% |   2.03 |         1.44 |     0.48 | -67.82% / -67.62 | 0.0105 / 0.9429 / 0.9321 |
| F3     | Train      |  20.51% / +12.37 |    15.99% / +7.62 |            1.04 / 0.72 |  9.25% |   0.47 |         0.68 |     0.14 | -38.93% / -52.09 | 0.0218 / 0.8721 / 0.8446 |
| F3     | Validation |   -0.03% / +0.47 |    -3.16% / -1.86 |            0.52 / 0.52 |  5.34% |   0.40 |         0.39 |     0.09 | -17.02% / -14.40 | 0.1887 / 0.6636 / 0.6357 |
| F3     | Holdout    |  21.33% / +10.67 |    17.64% / +7.83 |            2.08 / 1.21 |  5.06% |   1.75 |         0.72 |     0.15 | -20.74% / -20.54 | 0.0120 / 0.9492 / 0.9391 |
| F4     | Train      |  32.21% / +23.68 |   27.09% / +18.59 |            1.14 / 0.89 | 10.04% |   0.61 |         0.90 |     0.17 | -55.03% / -68.19 | 0.0063 / 0.9386 / 0.9220 |
| F4     | Validation |    1.37% / +3.01 |    -3.04% / -0.29 |            0.65 / 0.71 |  5.61% |   0.69 |         0.61 |     0.23 | -37.17% / -34.56 | 0.1270 / 0.7516 / 0.7271 |
| F4     | Holdout    |  26.58% / +15.94 |   20.63% / +10.13 |            1.85 / 1.26 |  6.16% |   1.88 |         0.73 |     0.24 | -37.34% / -37.14 | 0.0072 / 0.9562 / 0.9473 |

## All 11 calendar years at 10 bp

Each family cell is **zero-idle net / SHY-idle net / SHY-idle excess (pp)**. All eleven years support
the same cost sweep in the ledger. Three of four representatives had positive net in 10 of 11 years.
Relative to SHY, the representatives had 9 or 10 positive years apiece. Only F2 had positive net in 2022.

| Calendar year | Sessions | Passive SHY |                      F1 |                       F2 |                      F3 |                       F4 |
| ------------- | -------: | ----------: | ----------------------: | -----------------------: | ----------------------: | -----------------------: |
| 2016          |      252 |       0.62% |   2.91% / 3.48% / +2.87 |    2.18% / 3.07% / +2.45 |   2.91% / 3.48% / +2.87 |    2.71% / 3.37% / +2.75 |
| 2017          |      251 |       0.26% |   4.91% / 4.91% / +4.65 | 17.38% / 17.38% / +17.12 |   4.15% / 4.07% / +3.81 |    8.34% / 8.32% / +8.06 |
| 2018          |      251 |       1.46% |   0.53% / 0.53% / -0.93 |  -3.35% / -3.35% / -4.81 |   0.34% / 0.34% / -1.12 |  -0.62% / -0.62% / -2.08 |
| 2019          |      252 |       3.39% | 11.66% / 11.66% / +8.27 |    9.75% / 9.75% / +6.36 | 11.66% / 11.66% / +8.27 |  11.17% / 11.17% / +7.78 |
| 2020          |      253 |       3.03% |   0.61% / 0.60% / -2.43 |    7.44% / 7.44% / +4.41 |   1.24% / 1.24% / -1.79 |    3.85% / 3.85% / +0.82 |
| 2021          |      252 |      -0.71% |   6.44% / 6.44% / +7.15 | 26.61% / 26.61% / +27.32 |   6.05% / 5.95% / +6.67 | 11.05% / 11.01% / +11.72 |
| 2022          |      251 |      -3.88% | -2.71% / -2.71% / +1.17 |    1.14% / 1.14% / +5.03 | -2.76% / -2.76% / +1.12 |  -1.51% / -1.56% / +2.33 |
| 2023          |      250 |       4.17% |   7.21% / 7.21% / +3.04 | 15.71% / 15.71% / +11.54 |   7.33% / 7.26% / +3.09 |    9.59% / 9.60% / +5.43 |
| 2024          |      252 |       3.92% | 10.66% / 10.66% / +6.74 |  13.00% / 13.00% / +9.08 | 10.15% / 10.23% / +6.31 |    9.65% / 9.79% / +5.87 |
| 2025          |      250 |       4.95% |   9.81% / 9.81% / +4.87 | 29.70% / 29.70% / +24.75 |   8.56% / 8.75% / +3.80 |  14.84% / 14.89% / +9.94 |
| 2026          |      227 |       1.54% |   5.88% / 5.88% / +4.33 | 17.42% / 17.42% / +15.88 |   6.70% / 6.69% / +5.15 |    8.77% / 8.77% / +7.23 |

## Leave-one-ETF-out at 10 bp

Each cell is SHY-idle excess (pp) in **Train / Validation / Holdout**, with the omitted ticker removed from
both the signal and trading book. Passive SHY and SPY remain external comparators. The ledger retains all
**21,576** omission folds, including both books' turnover and net. Identical cells can mean the ticker was
not used by that configuration.

| Omitted ETF |                      F1 |                       F2 |                      F3 |                       F4 |
| ----------- | ----------------------: | -----------------------: | ----------------------: | -----------------------: |
| SPY         | +20.91 / +4.73 / +17.15 | +65.83 / +17.04 / +61.18 | +21.17 / +4.65 / +15.69 |  +33.25 / +7.71 / +26.25 |
| QQQ         | +18.85 / +3.94 / +17.77 | +64.17 / +17.27 / +61.34 | +18.11 / +4.32 / +15.88 |  +31.32 / +7.65 / +26.39 |
| IWM         | +22.24 / +4.18 / +17.91 | +66.49 / +17.24 / +62.34 | +21.18 / +4.17 / +17.15 |  +34.34 / +7.81 / +26.66 |
| SMH         | +22.24 / +4.18 / +17.91 | +62.62 / +16.52 / +58.55 | +21.18 / +4.17 / +17.15 |  +33.60 / +7.71 / +25.78 |
| XLK         | +22.24 / +4.18 / +17.91 | +63.61 / +16.88 / +60.93 | +21.18 / +4.17 / +17.15 |  +33.83 / +7.79 / +26.29 |
| XLF         | +22.24 / +4.18 / +17.91 | +66.76 / +16.83 / +60.80 | +21.18 / +4.17 / +17.15 |  +34.46 / +7.73 / +26.40 |
| XLV         | +22.24 / +4.18 / +17.91 | +65.94 / +17.05 / +60.35 | +21.18 / +4.17 / +17.15 |  +34.33 / +7.79 / +26.33 |
| XLY         | +22.24 / +4.18 / +17.91 | +65.87 / +17.89 / +62.47 | +21.18 / +4.17 / +17.15 |  +34.31 / +7.98 / +26.70 |
| XLC         | +22.24 / +4.18 / +17.91 | +66.36 / +17.40 / +61.40 | +21.18 / +4.17 / +17.15 |  +34.36 / +7.92 / +26.49 |
| XLI         | +22.24 / +4.18 / +17.91 | +66.49 / +16.39 / +61.99 | +21.18 / +4.17 / +17.15 |  +34.42 / +7.65 / +26.59 |
| XLP         | +22.24 / +4.18 / +17.91 | +67.66 / +17.20 / +61.29 | +21.18 / +4.17 / +17.15 |  +34.73 / +7.85 / +26.49 |
| XLE         | +22.24 / +4.18 / +17.91 | +69.13 / +13.92 / +60.30 | +21.18 / +4.17 / +17.15 |  +34.78 / +7.11 / +26.36 |
| XLU         | +22.24 / +4.18 / +17.91 | +66.97 / +17.31 / +60.58 | +21.18 / +4.17 / +17.15 |  +34.51 / +7.84 / +26.36 |
| XLRE        | +22.24 / +4.18 / +17.91 | +66.29 / +17.54 / +62.05 | +21.18 / +4.17 / +17.15 |  +34.32 / +7.87 / +26.61 |
| XLB         | +22.24 / +4.18 / +17.91 | +67.01 / +16.51 / +62.59 | +21.18 / +4.17 / +17.15 |  +34.50 / +7.71 / +26.72 |
| TLT         | +17.26 / +4.00 / +18.21 | +67.00 / +16.97 / +64.63 | +16.96 / +4.54 / +17.42 |  +31.03 / +8.14 / +28.88 |
| IEF         | +26.00 / +5.39 / +20.70 | +67.79 / +13.95 / +61.84 | +25.71 / +6.24 / +18.88 |  +39.03 / +7.24 / +28.82 |
| SHY         | +21.52 / +4.18 / +17.91 | +64.85 / +16.91 / +61.34 | +20.68 / +4.24 / +16.84 |  +33.55 / +7.81 / +26.22 |
| HYG         | +22.24 / +4.18 / +17.91 | +30.12 / +36.15 / +76.83 | +21.18 / +4.17 / +17.15 | +26.08 / +11.58 / +32.43 |
| LQD         | +22.24 / +4.18 / +17.91 | +66.60 / +16.80 / +62.43 | +21.18 / +4.17 / +17.15 |  +33.13 / +7.91 / +29.05 |
| GLD         | +18.76 / +1.71 / +11.54 | +88.71 / +14.20 / +20.72 | +18.31 / +1.46 / +10.10 |  +34.44 / +4.75 / +13.65 |
| SLV         | +22.24 / +4.18 / +17.91 | +70.86 / +18.56 / +67.44 | +21.18 / +4.17 / +17.15 |  +35.37 / +8.19 / +27.59 |
| USO         | +22.24 / +4.18 / +17.91 | +61.78 / +15.25 / +54.81 | +21.18 / +4.17 / +17.15 |  +33.35 / +7.35 / +25.32 |
| DBC         | +20.49 / +5.73 / +19.24 | +49.28 / +20.97 / +61.44 | +20.80 / +4.07 / +16.90 |  +27.95 / +7.83 / +29.33 |
| EFA         | +24.21 / +3.50 / +18.33 | +67.77 / +16.66 / +61.76 | +22.73 / +4.54 / +17.35 |  +35.07 / +7.72 / +26.43 |
| EEM         | +23.77 / +4.56 / +18.02 | +68.23 / +17.46 / +61.60 | +22.64 / +4.56 / +17.37 |  +35.44 / +8.24 / +26.40 |
| VNQ         | +22.24 / +4.18 / +17.91 | +67.10 / +17.53 / +62.06 | +21.18 / +4.17 / +17.15 |  +34.46 / +7.87 / +26.62 |
| DIA         | +22.24 / +4.18 / +17.91 | +65.81 / +16.66 / +61.79 | +21.18 / +4.17 / +17.15 |  +34.28 / +7.70 / +26.57 |
| UUP         | +33.76 / -1.57 / +21.12 |  +70.65 / +7.31 / +61.34 | +34.32 / -4.02 / +19.17 |  +43.49 / -1.18 / +29.86 |

## What passed

Structural = positive SHY excess and <4×/yr in every split. Robust also requires positive Ex-Top-5 and
Ex-Top-10 paired excess in each split. Plateau is the representative's fraction of robust one-field
neighbors. All-omission pass counts require positive excess and <4×/yr in every omitted split.
Qualification adds the plateau and Holdout p/DSR thresholds at all four costs.

| Family |    RT | Structural | Robust | Leader plateau | All omissions pass | Qualified at tier |
| ------ | ----: | ---------: | -----: | -------------: | -----------------: | ----------------: |
| F1     |  2 bp |      18/18 |   0/18 |          0.00% |               0/18 |              0/18 |
| F1     |  5 bp |      18/18 |   0/18 |          0.00% |               0/18 |              0/18 |
| F1     | 10 bp |      18/18 |   0/18 |          0.00% |               0/18 |              0/18 |
| F1     | 20 bp |      18/18 |   0/18 |          0.00% |               0/18 |              0/18 |
| F2     |  2 bp |       9/16 |   0/16 |          0.00% |               7/16 |              0/16 |
| F2     |  5 bp |       9/16 |   0/16 |          0.00% |               7/16 |              0/16 |
| F2     | 10 bp |       9/16 |   0/16 |          0.00% |               7/16 |              0/16 |
| F2     | 20 bp |       9/16 |   0/16 |          0.00% |               7/16 |              0/16 |
| F3     |  2 bp |      12/12 |   0/12 |          0.00% |               0/12 |              0/12 |
| F3     |  5 bp |      12/12 |   0/12 |          0.00% |               0/12 |              0/12 |
| F3     | 10 bp |      12/12 |   0/12 |          0.00% |               0/12 |              0/12 |
| F3     | 20 bp |      12/12 |   0/12 |          0.00% |               0/12 |              0/12 |
| F4     |  2 bp |      16/16 |   0/16 |          0.00% |               2/16 |              0/16 |
| F4     |  5 bp |      16/16 |   0/16 |          0.00% |               2/16 |              0/16 |
| F4     | 10 bp |      16/16 |   0/16 |          0.00% |               2/16 |              0/16 |
| F4     | 20 bp |      16/16 |   0/16 |          0.00% |               1/16 |              0/16 |

## Read or reproduce the ledger

- Read `metrics[trial][cost][window]` with `trials`, `costs`, `windows`, and `columns`. There are
  **3,720** scorecards. Each contains both books' metrics and the SHY-idle p-value, cumulative DSR and
  wider DSR. Return fields are decimals, not percentages. `windows` carries passive returns and session counts.
- Read `omissions[symbol][trial][cost][split]` with `omissionSymbols`, `omissionWindows` and
  `omissionColumns`. `neighbors` lists registered trial indices. `assessments[trial][cost]`
  contains the structural, robust, plateau, omission and cost-tier pass fields; `qualified` requires
  passing every tier. In `freeze.json`, `development[trial][cost][split][book]` has only the two
  development folds and no Holdout results.

Install the pinned repository dependencies with `bun install --frozen-lockfile`. With authorized
read access, download the four pinned object files under the two `sources[].prefix` paths into a
local directory, keeping object-key-relative paths (`MANIFEST.json` and `sources[].file` per prefix).
Run from the repository root with the Wave 5C branch fetched from `origin`:

```sh
bun services/bayn/tools/research-10yr-vol-regime-carry.ts \
  --score "$archive_dir" f38e5ce654d22e9119a1f0b2beb63e29a49dcccf
git diff --exit-code -- docs/bayn/evidence/2026-11-27-10yr-vol-regime-carry/results.json
```

This is a daily-bars simulation with modeled costs, not a quote replay. A future study would need previously
unseen sessions and executable opening prices before reassessing the concentration and implementation risks.
