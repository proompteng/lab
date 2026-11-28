# Wave 19F: 10-year volatility-targeted cross-asset trend

**DO NOT PROMOTE.** The 25% overlay reduced Holdout maximum drawdown in all six configurations at
2, 5 and 10 bp one-way, but **every one of those 18 comparisons lowered both net CAGR and Sharpe**
against the equal-capital B0/F4/O1 stack. None of the 30 standalone, pair or stack trials reached
Holdout DSR ≥ 0.95 or nominal stationary-bootstrap p < 0.05 at any cost, even at 0 bp slippage.

- At 5 bp, the preregistered 10%-target/10%-deadband example cut Holdout MaxDD from **4.22% to 3.83%**.
  CAGR fell from **8.73% to 7.75%** and Sharpe from **1.56 to 1.44**. The CAGR and Sharpe losses
  also persisted over the common post-warm-up window at that cost.
- The trend sleeve was nearly uncorrelated to B0 in Holdout (**−0.034**), but correlated **+0.730**
  with F4 and **+0.753** with O1. The B0 pair gained 0.154 Sharpe and cut drawdown by 3.49 pp at 5 bp,
  while slightly reducing CAGR. The F4 and O1 pairs also cut drawdown, but each reduced Sharpe and CAGR.
- The 10% deadband reduced standalone Holdout turnover from **22.39× to 17.76× per year** at the
  10% target and 5 bp. That is still far above F4 (0.73×) and O1 (2.62×). A forecast limit is not
  a realized volatility target: the standalone example realized 6.97% annualized Holdout volatility.

## Data and registration

The [protocol](protocol.md) and runner were [committed and pushed before scoring](https://github.com/proompteng/lab/commit/22795bd84b6ad17ab525fc637f5031399020c8aa).
The authenticated SIP daily panel and B0's exact-62 intraday tapes matched on 2,741 sessions from
2016-01-04 through 2026-11-25. All ten registered trend ETFs had complete daily coverage. DBC
represented broad commodities; USO was present in the manifest but not part of the trend sleeve.
No bars were imputed. The first eligible trend fill was 2017-01-04 after 253 warm-up sessions.

| Window     | First session | Last session | Sessions |
| :--------- | :------------ | :----------- | -------: |
| Train      | 2016-01-04    | 2021-12-31   |    1,511 |
| Validation | 2022-01-03    | 2023-12-29   |      501 |
| Holdout    | 2024-01-02    | 2026-11-25   |      729 |
| Full       | 2016-01-04    | 2026-11-25   |    2,741 |
| Investable | 2017-01-04    | 2026-11-25   |    2,488 |

Before scoring, the replay reproduced B0 fixed-$100k net dollars to the cent by fold (2/5 bp round
trip; Full $103,533.58 / $69,780.16), F4 compounded returns by fold (10/20 bp round trip; Full
+111.1094% / +109.2766%), and O1's Full returns (2/5/10 bp round trip; +94.4297% / +92.8669% /
+90.2911%). B0 retained one missing held bar in the historical replay, with no missing entries
or unresolved exits. The input hashes, audits and all unrounded results are in [results.json](results.json).

## Holdout cost stress

`Stack` is equal-weight B0/F4/O1. `Trend` is the 10%-target/10%-deadband example; a combined book
replaces 25% of its named reference with trend and pays the modeled transfer cost. Each risk cell
shows **net CAGR / annualized Sharpe / MaxDD**. Inference compares Stack + Trend against Stack on
matched daily net excess. 0 bp still includes the fixed sell fee.

| One-way bp |                  Stack |                 Trend |          Stack + Trend | Stack + Trend p |   DSR |
| ---------: | ---------------------: | --------------------: | ---------------------: | --------------: | ----: |
|          0 | 12.62% / 2.205 / 3.86% | 6.64% / 0.956 / 5.61% | 11.13% / 2.027 / 3.71% |           0.950 | 0.001 |
|          2 | 11.05% / 1.948 / 3.97% | 5.88% / 0.854 / 6.15% |  9.77% / 1.793 / 3.76% |           0.924 | 0.006 |
|          5 |  8.73% / 1.562 / 4.22% | 4.76% / 0.702 / 6.95% |  7.75% / 1.441 / 3.83% |           0.873 | 0.013 |
|         10 |  4.97% / 0.917 / 4.63% | 2.91% / 0.447 / 8.26% |  4.48% / 0.856 / 4.02% |           0.734 | 0.002 |

Across the six stacked variants at 2/5/10 bp, Holdout MaxDD improved by **0.21–0.64 pp**, while CAGR
fell by **0.50–1.63 pp** and Sharpe fell by **0.061–0.194**. At 10 bp the example did improve Full
CAGR (+0.25 pp) and Sharpe (+0.050), but not Holdout. At that rate B0 alone had **−4.61% Holdout CAGR**;
the 20 bp round-trip scenario extrapolates beyond B0's published cost ladder.

The exact Wave 19F deflation family is **30 trials**, with separate cost-specific null Sharpe thresholds
estimated on 1,759 post-warm-up Train+Validation sessions. The stationary bootstrap uses 10,000
draws of mean 10-session blocks. Its p-values test positive mean paired excess, not the significance
of Sharpe or drawdown changes. No family member was reselected after the Holdout.

## Matched performance at 5 bp one-way

Turnover is annual one-way multiples of NAV. Breakeven (BE) is an **absolute zero-return** estimate
using the same window's zero-slippage turnover path, not an incremental benchmark threshold.
“>1,000” is a lower bound; passive funds made no trades in Holdout.

### Full

| Portfolio     |   CAGR | Ann. vol | Sharpe | Sortino | Calmar |  MaxDD | Turnover | BE (bp) |
| :------------ | -----: | -------: | -----: | ------: | -----: | -----: | -------: | ------: |
| SPY           | 14.12% |   17.56% |  0.841 |   1.181 |  0.418 | 33.79% |     0.05 |  >1,000 |
| SHY           |  1.69% |    1.56% |  1.083 |   1.685 |  0.296 |  5.70% |     0.05 |  >1,000 |
| B0            |  0.89% |    8.49% |  0.146 |   0.225 |  0.038 | 23.29% |   103.44 |     5.4 |
| F4            |  7.11% |    5.66% |  1.241 |   1.731 |  0.708 | 10.04% |     0.80 |   428.2 |
| O1            |  6.09% |    6.96% |  0.885 |   1.213 |  0.295 | 20.67% |     2.49 |   123.3 |
| Stack         |  4.78% |    4.91% |  0.975 |   1.459 |  0.509 |  9.38% |    35.83 |    11.5 |
| Trend         |  3.67% |    7.24% |  0.534 |   0.715 |  0.185 | 19.79% |    16.24 |    16.1 |
| B0 + Trend    |  1.68% |    6.56% |  0.286 |   0.429 |  0.146 | 11.48% |    81.85 |     6.0 |
| F4 + Trend    |  6.26% |    5.52% |  1.127 |   1.557 |  0.746 |  8.40% |     4.78 |    68.6 |
| O1 + Trend    |  5.50% |    6.61% |  0.843 |   1.154 |  0.332 | 16.60% |     6.02 |    49.4 |
| Stack + Trend |  4.53% |    4.90% |  0.928 |   1.350 |  0.567 |  7.99% |    30.99 |    12.1 |

### Holdout

| Portfolio     |   CAGR | Ann. vol | Sharpe | Sortino | Calmar |  MaxDD | Turnover | BE (bp) |
| :------------ | -----: | -------: | -----: | ------: | -----: | -----: | -------: | ------: |
| SPY           | 16.55% |   16.08% |  1.032 |   1.519 |  0.882 | 18.75% |     0.00 |       — |
| SHY           |  3.59% |    1.58% |  2.236 |   3.516 |  3.677 |  0.98% |     0.00 |       — |
| B0            |  5.58% |    9.32% |  0.628 |   1.203 |  0.611 |  9.13% |   101.57 |     7.7 |
| F4            | 11.56% |    6.02% |  1.846 |   2.690 |  1.877 |  6.16% |     0.73 |   746.6 |
| O1            |  8.78% |    6.87% |  1.259 |   1.854 |  1.385 |  6.33% |     2.62 |   164.7 |
| Stack         |  8.73% |    5.45% |  1.562 |   2.700 |  2.068 |  4.22% |    35.22 |    16.9 |
| Trend         |  4.76% |    6.97% |  0.702 |   0.962 |  0.685 |  6.95% |    17.76 |    18.1 |
| B0 + Trend    |  5.49% |    7.15% |  0.783 |   1.431 |  0.973 |  5.64% |    80.84 |     8.3 |
| F4 + Trend    |  9.83% |    5.91% |  1.616 |   2.311 |  1.829 |  5.37% |     5.09 |    97.1 |
| O1 + Trend    |  7.77% |    6.56% |  1.173 |   1.692 |  1.410 |  5.51% |     6.50 |    62.5 |
| Stack + Trend |  7.75% |    5.28% |  1.441 |   2.319 |  2.023 |  3.83% |    30.92 |    17.1 |

### Daily Pearson correlation (Full / Holdout)

| Portfolio     |              B0 |            F4 |            O1 |            SPY |
| :------------ | --------------: | ------------: | ------------: | -------------: |
| B0            |   1.000 / 1.000 | 0.004 / 0.066 | 0.019 / 0.137 | −0.015 / 0.036 |
| F4            |   0.004 / 0.066 | 1.000 / 1.000 | 0.783 / 0.875 |  0.618 / 0.634 |
| O1            |   0.019 / 0.137 | 0.783 / 0.875 | 1.000 / 1.000 |  0.600 / 0.578 |
| SPY           |  −0.015 / 0.036 | 0.618 / 0.634 | 0.600 / 0.578 |  1.000 / 1.000 |
| Trend         | −0.033 / −0.034 | 0.598 / 0.730 | 0.700 / 0.753 |  0.373 / 0.602 |
| Stack         |   0.587 / 0.651 | 0.757 / 0.773 | 0.785 / 0.820 |  0.513 / 0.497 |
| Stack + Trend |   0.428 / 0.494 | 0.789 / 0.841 | 0.847 / 0.885 |  0.523 / 0.584 |

### Calendar-year net returns

| Year  |     SPY |      B0 |     F4 |     O1 |  Stack |  Trend | Stack + Trend |
| :---- | ------: | ------: | -----: | -----: | -----: | -----: | ------------: |
| 2016  |  13.24% |  −5.94% |  3.37% |  0.57% | −0.70% |  0.00% |        −0.52% |
| 2017  |  21.75% |  −5.79% |  8.32% |  8.44% |  3.48% | 15.68% |         6.42% |
| 2018  |  −4.96% |   4.72% | −0.62% |  0.18% |  1.53% | −3.95% |         0.17% |
| 2019  |  31.14% | −10.03% | 11.17% | 12.34% |  4.01% |  6.79% |         4.71% |
| 2020  |  18.45% |  −2.73% |  3.85% |  0.68% |  0.77% | 10.05% |         3.07% |
| 2021  |  28.60% |   3.60% | 11.01% |  7.78% |  7.54% |  5.51% |         7.07% |
| 2022  | −18.18% |  12.15% | −1.56% |  5.30% |  5.37% | −5.85% |         2.51% |
| 2023  |  26.18% |  −0.26% |  9.60% |  6.37% |  5.24% | −0.27% |         3.87% |
| 2024  |  24.89% |   1.64% |  9.79% |  6.69% |  6.06% |  5.88% |         6.04% |
| 2025  |  17.72% |   4.67% | 14.89% | 12.37% | 10.71% |  7.11% |         9.84% |
| 2026¹ |   5.93% |   9.98% |  8.77% |  6.39% |  8.48% |  0.87% |         6.55% |

¹ Through 2026-11-25 only. The annual returns retain existing positions rather than re-entering on January 1.

## Reproduce and interpret

From the repository root with the existing read-only agents-artifacts archive access:

```sh
out=$(mktemp -d)
bun services/bayn/tools/research-10yr-vol-target-macro.ts --output "$out/results.json"
bunx oxfmt --config .oxfmtrc.json "$out/results.json"
cmp docs/bayn/evidence/2026-11-27-10yr-vol-target-macro/results.json "$out/results.json"
unlink "$out/results.json"
rmdir "$out"
```

The reader verifies immutable inputs before admitting bars. A rerun reproduced the published receipt byte for byte.
The Holdout is out of sample for this preregistration, not new to Bayn. The ETF roster and vendor-adjusted
marks are historical, fractional next-open fills are modeled, and sleeve transfers do not prove shared-account
execution, market impact, capacity, or independent causal evidence. The result changes no strategy,
broker permission or capital authority.
