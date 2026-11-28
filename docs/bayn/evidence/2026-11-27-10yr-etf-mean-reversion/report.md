# Wave 19R: 10.9-year next-open ETF pullback study

**DO NOT PROMOTE.** RSI2-10 earned **5.66% holdout CAGR** at 5 bp one-way. Its annualized residual alpha
against SPY, B0, F4, and O1 was **+3.74%** (stationary-bootstrap `p = 0.0393`; standalone `DSR = 0.9728`,
three trials). But its daily correlation with F4 was **0.316 at 5 bp** and **0.315 at 10 bp**, above the
registered **0.30** ceiling at both costs. At 5 bp, full-history CAGR was **1.33%** and full-history residual
alpha was **−0.17%**. Positive holdout residuals do not make the sleeve orthogonal or establish persistent alpha.

All eight ETFs were admitted to the same three fixed rules. All cost scenarios had **zero same-session round trips**
and no closed lot held more than five sessions. The looser thresholds were diagnostics, not eligible replacements.
This study changes no trading policy, broker configuration, or capital authority.

## What was run

The [protocol](protocol.md) was [published before price access](https://github.com/proompteng/lab/commit/b4ff39f7443141f314d0fa0d15491c6c739fdca1).
A [coverage-only amendment](https://github.com/proompteng/lab/commit/a52e261e1fcce7e423ad1cd2a9825bb4a6858aba)
was published before candidate scoring for the August 2019 archive outage. It changed no signal, order, cost,
or decision rule. The tool checks the amended protocol's SHA-256 before opening either tape.

- **Universe and windows.** `SPY, QQQ, IWM, SMH, XLK, XLF, XLE, XLI` each had a verified price for all 2,741
  sessions from 2016-01-04 through 2026-11-25. The first possible entry was 2016-10-18 after warming up the 200-session
  SMA. The sleeve starts in cash and runs through the 2023/2024 boundary without resetting positions. The rules
  were fixed before the run; the 2,012 sessions in 2016–2023 fit the statistical benchmarks and exposures, and the
  729 sessions from 2024-01-02 through 2026-11-25 are the chronological out-of-sample test for that fit. Bayn had
  already used this historical archive; this is not a new, independently blind ten-year sample. The fixed roster
  is not a point-in-time population of all ETFs, including closed funds.
- **Observed fills and marks.** Wilder RSI(2), both SMAs and 20-session inverse volatility use completed,
  total-return-adjusted SIP daily closes. Fills use the split-adjusted 09:30 ET bar open, not the daily `open`
  field or an auction fill guarantee. [Alpaca documents](https://docs.alpaca.markets/us/docs/market-data-faq)
  that daily bars are aggregated over the New York date and can admit some first-trade conditions excluded from
  minute opens. The two pinned 5-minute archives contained 8,641,719 and 3,923,737 rows and covered 21 early
  closes. The only early valuation marks were on 2019-08-12: 25 minutes early for IWM/SMH/XLE and 30 for
  XLK/XLF/XLI. All 09:30 marks remained present. The exception changes neither a fill nor a signal.
- **Portfolio economics.** The fully funded fractional ledger retains inactive ETF budgets as cash and does not
  resize held lots. The 0/2/5/10 bp tiers are all-in modeled costs per side, not historical spreads or impact.
  The candidate is **price return only**: dividends are not credited, cash earns zero, and taxes, settlement and
  auction-order feasibility are not modeled. Zero same-session round trips is a property of this standalone
  ledger, not a statement about an account running other sleeves. All variants had one open XLE lot at tape end;
  it is marked to market, not force-sold or included in completed-trade statistics.

## Full and holdout statistics at 5 bp one-way

CAGR uses elapsed calendar time; volatility, Sharpe, Sortino and turnover use 252 sessions. Win rate and profit
factor use net, closed trades grouped by exit date. One-way turnover is half of all executed buy and sell
notional relative to pretrade NAV, annualized. [Results](results.json) retains unrounded metrics for every tier.

| Window  | Rule    |  CAGR |   Vol | Sharpe | Sortino | Calmar | Max DD | Trades | Win rate | Profit factor | Turnover/yr |
| ------- | ------- | ----: | ----: | -----: | ------: | -----: | -----: | -----: | -------: | ------------: | ----------: |
| Full    | RSI2-10 | 1.33% | 4.70% |   0.31 |    0.42 |   0.09 | 14.61% |    668 |   63.32% |          1.26 |       7.70× |
| Full    | RSI2-15 | 1.73% | 5.47% |   0.34 |    0.47 |   0.14 | 12.60% |    964 |   64.00% |          1.23 |      11.07× |
| Full    | RSI2-20 | 2.63% | 6.00% |   0.46 |    0.65 |   0.18 | 15.01% |  1,227 |   64.30% |          1.29 |      14.06× |
| Holdout | RSI2-10 | 5.66% | 4.48% |   1.25 |    2.06 |   1.09 |  5.20% |    242 |   69.42% |          2.05 |      10.65× |
| Holdout | RSI2-15 | 4.19% | 5.58% |   0.77 |    1.19 |   0.70 |  6.02% |    336 |   61.61% |          1.47 |      14.41× |
| Holdout | RSI2-20 | 4.98% | 6.34% |   0.80 |    1.26 |   0.77 |  6.45% |    424 |   61.79% |          1.44 |      18.24× |

The [Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) uses the dispersion of
development daily Sharpes at each cost, with exact `N = 3`; there is no effective-trial discount, and the three
rules are highly correlated. Both one-sided p-values use 10,000 [stationary bootstrap](https://doi.org/10.1080/01621459.1994.10476870)
draws and a mean block of five sessions. The alpha test removes the same-day contributions of SPY, B0, F4 and O1
using slopes fixed on 2016–2023. It conditions on those fitted exposures, does not estimate a tradeable hedge and
does not remove the intercept. Full-window inference is descriptive because it includes the fit period.

| Window  | Rule    |    DSR | Standalone p | Annualized residual alpha | Alpha p |
| ------- | ------- | -----: | -----------: | ------------------------: | ------: |
| Full    | RSI2-10 | 0.6944 |       0.1195 |                    −0.17% |  0.5639 |
| Full    | RSI2-15 | 0.7333 |       0.1020 |                    −0.12% |  0.5356 |
| Full    | RSI2-20 | 0.8467 |       0.0426 |                    +0.57% |  0.3473 |
| Holdout | RSI2-10 | 0.9728 |       0.0076 |                    +3.74% |  0.0393 |
| Holdout | RSI2-15 | 0.8554 |       0.0671 |                    +1.93% |  0.2274 |
| Holdout | RSI2-20 | 0.8695 |       0.0551 |                    +2.52% |  0.1912 |

## Cost stress and calendar returns

Each CAGR cell is **Full / Holdout**. Break-even is the one-way cost where compounded return reaches zero
when repricing the entire path, not the cost where alpha or the promotion gate disappears.

| One-way cost |  RSI2-10 CAGR |  RSI2-15 CAGR |  RSI2-20 CAGR | Holdout residual alpha: 10 / 15 / 20 |
| -----------: | ------------: | ------------: | ------------: | -----------------------------------: |
|         0 bp | 2.12% / 6.79% | 2.86% / 5.70% | 4.08% / 6.91% |             +4.77% / +3.24% / +4.20% |
|         2 bp | 1.80% / 6.33% | 2.40% / 5.10% | 3.50% / 6.14% |             +4.35% / +2.71% / +3.52% |
|         5 bp | 1.33% / 5.66% | 1.73% / 4.19% | 2.63% / 4.98% |             +3.74% / +1.93% / +2.52% |
|        10 bp | 0.56% / 4.54% | 0.61% / 2.71% | 1.20% / 3.09% |             +2.74% / +0.65% / +0.88% |

| Rule    | Full break-even | Holdout break-even |
| ------- | --------------: | -----------------: |
| RSI2-10 |        13.62 bp |           30.92 bp |
| RSI2-15 |        12.75 bp |           19.29 bp |
| RSI2-20 |        14.26 bp |           18.37 bp |

Compounded annual net returns at 5 bp one-way (all costs in [results.json](results.json)):

| Calendar year  | Sessions | RSI2-10 | RSI2-15 | RSI2-20 |
| -------------- | -------: | ------: | ------: | ------: |
| 2016           |      252 |   0.69% |   0.67% |   0.43% |
| 2017           |      251 |   2.32% |   4.62% |   5.85% |
| 2018           |      251 |  −6.19% |  −5.58% |  −8.34% |
| 2019           |      252 |  −0.56% |   0.51% |   0.30% |
| 2020           |      253 |  −0.59% |   1.18% |   3.07% |
| 2021           |      252 |   8.05% |  11.22% |  15.99% |
| 2022           |      251 |  −4.25% |  −3.90% |  −2.68% |
| 2023           |      250 |  −0.36% |  −1.03% |   1.39% |
| 2024           |      252 |   7.46% |   7.15% |   8.30% |
| 2025           |      250 |   6.48% |   6.39% |   8.11% |
| 2026 to Nov 25 |      227 |   2.52% |  −1.18% |  −1.66% |

## Dated controls and correlations

The replay reproduced both Full and Holdout reference returns before scoring. [B0](https://github.com/proompteng/lab/pull/16387)
is the fixed-$100k Noise Area 30-minute / 1.4× / opposite-band / inverse-vol rule. Its Full/Holdout net at
2 bp **round-trip** was $103,533.58 / $40,443.36 to the cent; at 5 bp it was $69,780.16 / $31,628.26. Its one
historical held-bar gap follows the published replay and did not leave an unpriced exit. [F4](../2026-11-27-10yr-vol-regime-carry/README.md)
is the 42-session LQD parity ensemble with SHY idle carry, not the later account-sizing model. Its Full/Holdout
net at 10 bp round-trip was 111.11% / 37.21%. [O1](https://github.com/proompteng/lab/pull/16376) is the Wave 5D
base with SHY sweep and reproduced the [original 10 bp round-trip path](../2026-11-27-10yr-pure-etf-dual-horizon/README.md)
at 90.29% / 27.55%. SPY is the passive adjusted daily mark. The friction rate is matched by converting the
candidate's one-way tier to the controls' round-trip input; the controls retain their registered sell fee.

Daily Pearson matrix at 5 bp one-way, **Full**:

| Series  |    SPY |     B0 |    F4 |    O1 | RSI2-10 | RSI2-15 | RSI2-20 |
| ------- | -----: | -----: | ----: | ----: | ------: | ------: | ------: |
| SPY     |  1.000 | −0.015 | 0.618 | 0.600 |   0.390 |   0.442 |   0.465 |
| B0      | −0.015 |  1.000 | 0.004 | 0.019 |  −0.038 |  −0.023 |  −0.021 |
| F4      |  0.618 |  0.004 | 1.000 | 0.783 |   0.286 |   0.323 |   0.333 |
| O1      |  0.600 |  0.019 | 0.783 | 1.000 |   0.357 |   0.397 |   0.417 |
| RSI2-10 |  0.390 | −0.038 | 0.286 | 0.357 |   1.000 |   0.930 |   0.856 |
| RSI2-15 |  0.442 | −0.023 | 0.323 | 0.397 |   0.930 |   1.000 |   0.952 |
| RSI2-20 |  0.465 | −0.021 | 0.333 | 0.417 |   0.856 |   0.952 |   1.000 |

Daily Pearson matrix at 5 bp one-way, **Holdout**:

| Series  |   SPY |     B0 |    F4 |    O1 | RSI2-10 | RSI2-15 | RSI2-20 |
| ------- | ----: | -----: | ----: | ----: | ------: | ------: | ------: |
| SPY     | 1.000 |  0.036 | 0.634 | 0.578 |   0.456 |   0.572 |   0.583 |
| B0      | 0.036 |  1.000 | 0.066 | 0.137 |  −0.107 |  −0.074 |  −0.062 |
| F4      | 0.634 |  0.066 | 1.000 | 0.875 |   0.316 |   0.388 |   0.395 |
| O1      | 0.578 |  0.137 | 0.875 | 1.000 |   0.298 |   0.384 |   0.385 |
| RSI2-10 | 0.456 | −0.107 | 0.316 | 0.298 |   1.000 |   0.901 |   0.842 |
| RSI2-15 | 0.572 | −0.074 | 0.388 | 0.384 |   0.901 |   1.000 |   0.959 |
| RSI2-20 | 0.583 | −0.062 | 0.395 | 0.385 |   0.842 |   0.959 |   1.000 |

## Reproduce

From the repository root with read access to the existing Bayn S3 research archives:

```sh
evidence=docs/bayn/evidence/2026-11-27-10yr-etf-mean-reversion
work=$(mktemp -d)
trap 'test ! -f "$work/results.json" || unlink "$work/results.json"; rmdir "$work"' EXIT
bun services/bayn/tools/research-10yr-etf-mean-reversion.ts --output "$work/results.json"
bunx oxfmt "$work/results.json"
cmp "$evidence/results.json" "$work/results.json"
```

The [machine-readable results](results.json) bind the published protocol, archive receipts, and daily ledger
digests without committing source prices or credentials.
