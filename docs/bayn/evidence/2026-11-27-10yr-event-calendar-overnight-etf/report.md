# Wave 18C: calendar-event overnight ETF study

**DO NOT PROMOTE.** The H4 composite had **zero modeled regular-session exposure** and near-zero
daily correlation to the QQQ+SMH B0 intraday replay. That timing separation did not make it an
orthogonal source of returns: Holdout correlations at 10 bp round trip were +0.339 to F4, +0.305
to O1, and +0.262 to SPY. All exceeded the 0.25 cap. Allocating 25% to H4 lowered both Sharpe and
Holdout return in all three registered portfolio comparisons.

H4's full-sample net Sharpe fell from **0.960 at 0 bp** to **0.077 at 5 bp** and **−0.808 at 10 bp**.
Full-sample wealth broke even at **5.34 bp round trip**, with an additional 0.21 bp sell fee already
charged. At 5 bp, H4 made 0.20% CAGR but was positive in only three of the ten 2016–2025
calendar-year buckets. No trial attained the 0.95 Holdout DSR threshold at any cost, even at 0 bp.

## What ran

The [protocol](protocol.md) and scoring code were committed before replay in
[`3cd36cf5c`](https://github.com/proompteng/lab/commit/3cd36cf5c2425bf90dc191fc45e9cc4b320fad55).
A read-only run against the cluster's Rook-Ceph S3 archive verified **2,741** Alpaca SIP sessions from
2016-01-04 through **2026-11-25**. The scored panel starts on 2016-01-05 and contains **2,740**
aligned sessions, including 729 in Holdout. Daily bars use split-and-dividend adjustment; the
24-hour diagnostic uses only split-adjusted 5-minute marks. The published
[F4](../2026-11-27-10yr-vol-regime-carry/README.md), [O1](../2026-11-27-etf-canary-macro-v2/README.md)
and [B0](../2026-11-27-10yr-qqq-smh-conditioning/README.md) split totals reproduced at their pinned
costs before comparison. [results.json](results.json) retains the input receipts, split oracles,
all 31 trials × four costs, yearly and split returns, path digests, and unrounded gates.

- The calendar had 652 turn-of-month, 86 scheduled FOMC, and 101 pre-holiday exit sessions.
  Their union was 776 sessions; the risk and warmup rules admitted 693. H4 therefore closed
  **3,465 ETF round trips** (995 in Holdout), with no stacking on overlapping dates.
- The [Fed advance schedules](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm)
  registered eight dates per year. The March 2020 meeting was canceled before entry; December
  2026 is outside the price tape. The November 25, 2026 pre-Thanksgiving session was known
  from the exchange schedule without reading a later price.
- The literal 24-hour FOMC and pre-holiday open-to-close tests, and the turn-of-month close-to-close
  test, have regular-session exposure. They do not enter H4. H4 hypothetically enters on the
  previous close and is flat at the open, without using either execution mark to choose its weight.

## H4 net economics and slippage

0 bp removes modeled slippage, not the sell fee. Volatility and drawdown are shown as positive magnitudes.
Turnover is annual one-way traded notional relative to equity; win rate and profit factor are measured on
closed ETF round trips. All performance is modeled and net of the registered costs.

| RT bp | Net return |   CAGR | Ann. vol | Sharpe | Sortino | Calmar |  MaxDD | Win rate | Profit factor | Turnover/yr | Trades |
| ----: | ---------: | -----: | -------: | -----: | ------: | -----: | -----: | -------: | ------------: | ----------: | -----: |
|     0 |     41.81% |  3.26% |    3.41% |  0.960 |   1.345 |  0.750 |  4.35% |   56.97% |         1.245 |      60.22× |  3,465 |
|     2 |     24.40% |  2.03% |    3.40% |  0.608 |   0.828 |  0.440 |  4.60% |   55.41% |         1.148 |      60.22× |  3,465 |
|     5 |      2.22% |  0.20% |    3.39% |  0.077 |   0.100 |  0.031 |  6.48% |   53.13% |         1.014 |      60.21× |  3,465 |
|    10 |    −26.31% | −2.76% |    3.40% | −0.808 |  −0.993 | −0.099 | 28.02% |   48.34% |         0.818 |      60.19× |  3,465 |

| RT bp |   Train | Validation | Holdout | Holdout Sharpe | Holdout DSR | Holdout block p | Full DSR | Full block p | Positive years |
| ----: | ------: | ---------: | ------: | -------------: | ----------: | --------------: | -------: | -----------: | -------------: |
|     0 |  23.67% |      4.70% |   9.51% |          0.698 |     0.41453 |         0.10519 |  0.65002 |      0.00050 |          10/10 |
|     2 |  14.89% |      2.51% |   5.63% |          0.431 |     0.24718 |         0.22838 |  0.22290 |      0.01780 |          10/10 |
|     5 |   2.88% |     −0.70% |   0.06% |          0.028 |     0.06156 |         0.49335 |  0.00240 |      0.40106 |           3/10 |
|    10 | −14.41% |     −5.83% |  −8.58% |         −0.643 |     0.00039 |         0.87421 |  8.1e−13 |      0.99790 |           1/10 |

DSR uses all **31** registered trials at each fixed cost and a Train+Validation null Sharpe. The
one-sided stationary bootstrap uses 10,000 circular draws and mean block length 10. The p-value
tests mean daily return over zero, not SPY or an after-the-fact portfolio. Full-sample inference
is descriptive; it cannot rescue a failed Holdout.

## Matched daily comparison

At **10 bp round trip** the standalone benchmarks had the following full-sample results. SPY is
frictionless buy-and-hold. F4 and O1 use their published models including SHY idle; B0 uses daily
P&L normalized by the published fixed capital.

| Sleeve |   CAGR | Ann. vol | Sharpe |  MaxDD |
| -----: | -----: | -------: | -----: | -----: |
|    SPY | 14.08% |   17.56% |  0.840 | 33.79% |
|     F4 |  7.11% |    5.67% |  1.243 | 10.04% |
|     O1 |  6.09% |    6.96% |  0.886 | 20.67% |
|     B0 |  0.89% |    8.49% |  0.147 | 23.29% |
|     H4 | −2.76% |    3.40% | −0.808 | 28.02% |

**Pearson correlation at 10 bp, Full / Holdout.** Both matrices use every matched session, not
only event or traded sessions. The JSON retains separate matrices at all costs.

| Sleeve |              H4 |            SPY |            F4 |            O1 |              B0 |
| ------ | --------------: | -------------: | ------------: | ------------: | --------------: |
| H4     |   1.000 / 1.000 |  0.218 / 0.262 | 0.288 / 0.339 | 0.246 / 0.305 | −0.016 / −0.013 |
| SPY    |   0.218 / 0.262 |  1.000 / 1.000 | 0.618 / 0.634 | 0.600 / 0.578 |  −0.015 / 0.036 |
| F4     |   0.288 / 0.339 |  0.618 / 0.634 | 1.000 / 1.000 | 0.783 / 0.875 |   0.004 / 0.066 |
| O1     |   0.246 / 0.305 |  0.600 / 0.578 | 0.783 / 0.875 | 1.000 / 1.000 |   0.019 / 0.137 |
| B0     | −0.016 / −0.013 | −0.015 / 0.036 | 0.004 / 0.066 | 0.019 / 0.137 |   1.000 / 1.000 |

**Fixed 25% H4 allocation at 10 bp.** Return lift is in percentage points of compounded Holdout
wealth. Incremental p tests a positive daily return difference using paired stationary resampling.

| Reference      | Full Sharpe lift | Holdout Sharpe lift | Holdout return lift | Incremental p |
| -------------- | ---------------: | ------------------: | ------------------: | ------------: |
| F4             |           −0.240 |              −0.340 |           −13.16 pp |       1.00000 |
| O1             |           −0.171 |              −0.240 |           −10.08 pp |       0.99940 |
| Equal F4+O1+B0 |           −0.243 |              −0.315 |           −10.04 pp |       0.99960 |

## Yearly net returns

H4 is shown at both 5 and 10 bp round trip; traded controls are shown at 10 bp. The 2016 balance
starts at the first scored pair, and 2026 ends on November 25.

| Year     | H4 (5 bp) | H4 (10 bp) |     SPY |     F4 |     O1 |      B0 |
| -------- | --------: | ---------: | ------: | -----: | -----: | ------: |
| 2016     |    −1.48% |     −3.96% |  13.00% |  3.43% |  0.63% |  −5.94% |
| 2017     |    −0.40% |     −3.87% |  21.75% |  8.32% |  8.44% |  −5.79% |
| 2018     |    −1.48% |     −4.49% |  −4.96% | −0.62% |  0.18% |   4.72% |
| 2019     |     1.64% |     −1.61% |  31.14% | 11.17% | 12.34% | −10.03% |
| 2020     |     3.86% |      1.37% |  18.45% |  3.85% |  0.68% |  −2.73% |
| 2021     |     0.81% |     −2.67% |  28.60% | 11.01% |  7.78% |   3.60% |
| 2022     |    −0.59% |     −2.56% | −18.18% | −1.56% |  5.30% |  12.15% |
| 2023     |    −0.11% |     −3.35% |  26.18% |  9.60% |  6.37% |  −0.26% |
| 2024     |    −0.68% |     −4.00% |  24.89% |  9.79% |  6.69% |   1.64% |
| 2025     |    −1.73% |     −4.66% |  17.72% | 14.89% | 12.37% |   4.67% |
| 2026 YTD |     2.51% |     −0.12% |   5.93% |  8.77% |  6.39% |   9.98% |

## H1–H3 diagnostics

Full-sample Sharpe at **10 bp round trip**. Each cell is its own trial; no single-ETF winner
or intraday window can be substituted for H4.

| Rule              |    SPY |    QQQ |    TLT |    GLD |    IWM |
| ----------------- | -----: | -----: | -----: | -----: | -----: |
| H1 overnight      | −0.839 | −0.592 | −1.541 | −0.164 | −0.514 |
| H1 close-to-close |  0.557 |  0.532 |  0.125 |  0.495 |  0.241 |
| H2 overnight      |  0.431 |  0.749 |  0.411 | −0.122 |  0.333 |
| H2 nominal 24h    |  0.392 |  0.596 |  0.488 |  0.122 |  0.345 |
| H3 overnight      | −0.191 | −0.077 | −0.397 |  0.057 |  0.092 |
| H3 open-to-close  |  0.058 | −0.097 | −0.602 | −0.203 |  0.230 |

H1's close-to-close measurements cannot establish overnight edge: every ETF's H1 overnight
Sharpe was negative at stress. The QQQ H2 overnight variant had Holdout Sharpe 0.769 but only
23 Holdout round trips, DSR 0.182, and stationary p = 0.09029. It is a diagnostic, not a qualified
substitute. H3 showed no consistent edge across ETFs.

## Reproduce

From the repository root, with read-only access to the existing `agents-artifacts` S3 archive:

```sh
out=$(mktemp -d)
bun services/bayn/tools/research-10yr-event-calendar-etf.ts --output "$out/results.json"
bunx oxfmt "$out/results.json"
cmp "$out/results.json" docs/bayn/evidence/2026-11-27-10yr-event-calendar-overnight-etf/results.json
unlink "$out/results.json"
rmdir "$out"
```

Two full archive replays reproduced the same bytes. The formatted results SHA-256 is
`085a51d876144c1a0d89d68cc0f44dc3033b25d3c0808c975f54df5bdc4a00f3`.
The scorer refuses to overwrite an existing
artifact and emits nothing on bad archive hashes, missing required prices, calendar divergence,
or a failed control oracle. The modeled auction and intraday bar marks do not establish realizable
fills, market impact, shared-account capacity, or the opportunity cost of idle cash. The date split
does not make these historically researched tapes prospective. No policy, deployment, or capital
authority changes as a result of this study.
