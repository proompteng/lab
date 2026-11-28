# Wave 6C: Pure-ETF dual-horizon portfolio proof

**Retrospective research only.** The six specified mixes are scored on 2,741 official U.S. regular sessions
from the 2016-01-04 open through the 2026-11-25 close (10.894132 annualization years; 11 calendar buckets).
No single stock trades, sleeve retuning, mix search, live policy change, or authorization to trade.
[Machine-readable results](results.json) cover both sizing modes, both carry treatments, all four friction tiers,
each calendar year and split, benchmark comparisons, reconciliation totals, and per-ledger SHA-256 receipts.

At 2 bp round trip with SHY carry, **M4** grew $100,000 to **$217,388** (**7.39% CAGR**,
**+$97,364 vs SHY**, **0.812 IR**, **20.30% MaxDD**). **M5** earned more (**8.23% CAGR** and **0.904 IR**),
while **M6** had a shallower **12.70% MaxDD**. All three had lower CAGR than 60/40 or SPY.
M4's O1/I1 standalone correlation was **−0.022** over the full period and **−0.047** during SPY
drawdowns. That does not prevent severe drawdowns: M4's resampled 95% MaxDD VaR was **26.19%**.
At 10 bp, M4 remained above SHY while the two intraday-only SHY books fell below it.
These are comparisons of registered mixes, not a reason to choose or promote the best row.

## Frozen engines and provenance

| Engine | Reconstructed rules                                                                                                                                                                                                                                           | Prior evidence and scope                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1     | Wave 5D panel A breadth canary (21-session cadence, top 3 offense / top 2 defense, inverse volatility), long 8%-target TSMOM, and 63-session macro EMA. Covariance-shrunk fixed risk budgets; 21-session reviews and 5-point drift band after 252 returns.    | [#16376](https://github.com/proompteng/lab/pull/16376), [frozen source and results](https://github.com/proompteng/lab/tree/06e85b0e59f70c8b09181266a883179c8c90b498/docs/bayn/evidence/2026-11-27-etf-canary-macro-v2).                                                                                                   |
| O2     | Wave 3C five-arm blend: signed 120-session trend, pension −5/2% long, turn-of-month −2/+4 with 15% target, SMA100 RSI(2) pullback (15/70), and 120-session credit-filtered rotation. Original 60-session inverse paper-vol budgets updated every fifth close. | [#16367](https://github.com/proompteng/lab/pull/16367), [frozen source and results](https://github.com/proompteng/lab/tree/1731c7ede32f22306aaf55e101fc8354978b0445/docs/bayn/evidence/2026-11-27-10yr-multi-asset-risk-premia). Diagnostic comparator, not a qualified study.                                            |
| I1     | Wave 5A C5: QQQ and SMH, first 1.2× 30-minute Noise Area band breach, opposite-band exit, 14 prior complete RTH sessions for band and ATR, $1,500 total ATR risk, $60,000 per-leg ceiling at $100k, whole shares.                                             | [#16377](https://github.com/proompteng/lab/pull/16377), [frozen source and results](https://github.com/proompteng/lab/tree/73b26d5ad6875064fe4df4dcdc5bf1a844949112/docs/bayn/evidence/2026-11-27-8yr-unseen-intraday-oos). The 2,012 sessions in 2016–2023 were blind in that study; 2024–2026 was inspected continuity. |
| I2     | Same Noise rule/total risk and inverse-dollar-ATR share sizing as I1, with risk divided over SPY, QQQ, IWM and SMH. No new calibration, and no redistribution from unavailable names.                                                                         | Comparator in this synthesis, not a separately proven blind champion.                                                                                                                                                                                                                                                     |

- **O1 identity check:** Original, uncapped-by-Wave-6C, compounded results at 2/5/10 bp are
  **94.42965714% / 92.86692789% / 90.29113849%** net. The exact base at 2 bp turns
  **2.18× / 3.20× / 2.62×** per year across the three splits, with **5.91%** Validation and **6.31%**
  Holdout MaxDD, **1.29** Holdout Sharpe and **0.04780** original Holdout p. The seemingly better
  drawdown and p headlines are ranges over ensemble variants in the upstream report, not this base's results.
  The upstream split protocol was pre-registered; the date range was not an independent fresh blind tape,
  and the base did not qualify.
- **O2 identity check:** The original open-to-open 10 bp fixed book, independently opened and
  liquidated by split, reproduces **+$45,435 with SHY** and **+$47,149 without idle SHY** in aggregate.
  The mission's $64.4k / $44.4k figures are not the 10 bp frozen split-stitched receipt. The harmonized
  2 bp fixed O2 comparator in this study uses a continuous close-to-close ledger and earns **+$61,816
  with SHY**, **+$43,433 vs fixed SHY**. Do not conflate these conventions.
- **I1 identity check:** Unshared, zero-carry 2 bp fixed P&L reproduces **+$41,848.66** on the blind
  tape and **+$67,164.47** stitched, to the cent. The original blind bootstrap (mean block 5, zero
  alpha null) reported p = **0.00850**. The paired-to-SHY bootstrap below uses a different null.
- ETF-only fixed rosters avoid selecting today's surviving **single stocks**. These archives do not
  contain a point-in-time universe of live and dead **funds**, and strategy selection used already-known
  evidence. They cannot prove blanket zero survivorship or selection bias. XLC is unavailable before
  2018-06-19 and XLRE is missing on two dates; neither is filled with a proxy.

## Data and execution evidence

Data are content-addressed: verify all four manifests, both calendars, four compressed objects, available
decoded digests, and row counts. The New York calendar handles short sessions and the actual DST clock.
The blind gzip object ends with 1,693 authenticated non-member bytes. Decode only its single pinned
member and retain all 8,641,719 rows. The recent 5-minute input retains 3,923,737 rows. Use only relevant
ETFs and RTH slots for Noise; use SIP total-return adjusted daily bars for overnight and benchmarks.
Gaps reset the affected symbol's 14-session warm-up; no synthetic signal bars or future warm-up.

**One exact frozen-tape limit for I2:** The archive has no 2019-08-12 IWM bar at the required
15:55 ET exit. The strict tape alone cannot resolve any booked trade with that exit. A separately
recorded read of [Alpaca historical SIP 5-minute bars](https://docs.alpaca.markets/us/reference/stockbars)
returned the exact 19:55 UTC slot, open **148.79**, and the 14:00 UTC overlapping anchor matched the
frozen bar's OHLC. The supplemental open is used for this one _execution mark only_, never for signals,
warm-up, or other fills; the original archive and all 2,741 dates remain unchanged. I2, M3 and M6 ledger
receipts flag the supplemental fill when taken. I1 and M1/M2/M4/M5 use no supplemental fill.
An absent entry is cancelled; other unresolved booked exit marks hard-fail rather than report fictional
flat P&L. The report records incomplete days, held gaps and missing entries separately.

## One account, six registered mixes

| Mix                      |   O1 |  O2 |   I1 |   I2 |
| ------------------------ | ---: | --: | ---: | ---: |
| M1 overnight             | 100% |   — |    — |    — |
| M2 intraday              |    — |   — | 100% |    — |
| M3 core intraday         |    — |   — |    — | 100% |
| M4 flagship dual-horizon | 100% |   — |  50% |    — |
| M5 balanced dual-horizon | 100% |   — | 100% |    — |
| M6 cross-ensemble        |  50% | 50% |    — |  50% |

- Start at $100,000. Fixed mode sizes targets on $100,000 but retains actual account equity for financing
  and broker limits; compounded mode sizes targets on post-fee opening equity, with no reset at the splits.
  Positions earn the prior-close-to-open move before changes at the next adjusted open. Net same-symbol
  overnight orders across O1, O2 and the SHY sweep. Keep sleeve exposure for attribution. No terminal sale.
- The overnight gross limit is the least of $150,000, 2× sizing equity and 2× actual equity. Reserve
  the opening overnight gross, including funded SHY, against $180,000 shared entry-reserved gross.
  Additional Noise gross cannot exceed 4× previous-close equity less maintenance (zero DTBP under
  $25,000). Implement Alpaca's published long/short maintenance price tiers on daily marks, not a
  historical account-buying-power feed. Pro-rata trim the overnight book at open and closing marks when
  necessary; the model does not assert peak mark-to-market compliance between observations.
- Skip any Noise entry whose ETF is already held in the opening overnight book. Process exits before
  new fills at a slot; reserve whole shares with the worst registered entry multiplier. Use the next
  5-minute bar's open for both entry and opposite-band exit; timed exits use the last 5-minute open at
  or before close minus two minutes. Noise positions are flat overnight; a funded SHY position is not
  an intraday leg. Release no exposure based on future price changes or unobserved orders.
- The four **1/2/5/10 bp round-trip** tiers are NBBO-scale _assumptions_, not measured spreads.
  Charge half per leg and 0.21 bp on sells. Charge 1.5% ACT/365 on prior-close short outstanding
  notional, and 6.5% ACT/360 on long overnight debit after outside cash and excluding short-sale
  proceeds. Days elapsed include weekends and holidays. No intraday borrowing charge. Costs omit
  taxes, locates, queue position, market impact, and historical variation in fee schedules and rate tiers.
- Carry is an actual allocation to [SHY](https://www.ishares.com/us/products/239452/ishares-132026-treasury-bond-etf),
  a 1–3 year Treasury ETF, not literal T-bills, an overnight deposit, or interest on collateral.
  The sweep uses unencumbered sizing equity after overnight gross at first open and target changes;
  trim it when capacity contracts. In M2/M3 sweep deployable equity after flattening Noise each day.
  Buying or selling the sweep incurs costs and consumes gross. Zero idle carry leaves deliberate
  SHY targets active. As compounded equity approaches the dollar caps, carry can displace intraday
  fills even if it raises the cash return.
- These are historical Reg-T/DTBP-style simulation rules, not evidence of tradability or executable size.
  The [Alpaca margin reference](https://docs.alpaca.markets/us/docs/margin-and-short-selling),
  [prior-close DTBP guide](https://docs.alpaca.markets/us/v1.1/docs/user-protection), and
  [newer intraday-margin methodology](https://docs.alpaca.markets/us/docs/the-intraday-margin-rule)
  distinguish modeled rules from account settings. Daily price proxies are dividend-adjusted for P&L,
  including financing notional proxies. No point-in-time borrow inventory or broker house margin is available.

## Performance at 2 bp round trip with SHY carry

SHY and SPY are frictionless adjusted return series; 60/40 is frictionless daily rebalanced 60% SPY / 40% IEF.
All use first-session open-to-close, then previous close to current close. Fixed comparisons sum daily
returns on the same $100,000 notional, while compounded comparisons multiply daily growth.
CAGR uses final wealth over initial wealth and the inclusive calendar span / 365.2425, not an exponent of
1/11. MaxDD is the fraction off peak in the respective wealth path. IR uses paired strategy-minus-SHY daily
returns; raw Sharpe and Sortino use zero as the daily hurdle. Ratios annualize to 252 sessions. Sortino uses
downside RMS with all sessions in the denominator. Calmar is CAGR/MaxDD. Ex-Top-5/10 remove the same dates
from strategy and comparator after ranking positive strategy returns; SPY beta and down-SPY net are computed
on matched dates (the latter uses strictly negative SPY days). JSON includes all these metrics by window.

The [stationary bootstrap](https://users.ssc.wisc.edu/~bhansen/718/Politis%20Romano.pdf) uses 10,000 trials,
circular geometric blocks of mean length 10 and a fixed seed. Reuse the same blocks across full-period scenarios.
The one-sided p-value uses centered paired daily excess with add-one correction. MaxDD VaR is the 95th
percentile and CVaR is the mean of the worst 5%, using uncentered resampled wealth paths. These quantify the
observed paths, not a reoptimization, new broker execution run, independently validated discovery, or a
multiplicity-adjusted qualification. SHY vs itself has no tracking error, so its IR is undefined.

### Compounded equity

| Mix   | Final equity | CAGR   | Excess vs SHY | IR    | Sharpe | Sortino | MaxDD  | Calmar | p       | DD VaR / CVaR 95% |
| ----- | ------------ | ------ | ------------- | ----- | ------ | ------- | ------ | ------ | ------- | ----------------- |
| M1    | $190,840     | 6.11%  | $70,817       | 0.662 | 0.919  | 1.259   | 20.64% | 0.296  | 0.01590 | 27.04% / 31.21%   |
| M2    | $173,891     | 5.21%  | $53,867       | 0.805 | 1.120  | 1.764   | 7.18%  | 0.726  | 0.00200 | 11.28% / 13.04%   |
| M3    | $153,527     | 4.01%  | $33,504       | 0.561 | 0.903  | 1.408   | 7.29%  | 0.551  | 0.02110 | 11.26% / 13.17%   |
| M4    | $217,388     | 7.39%  | $97,364       | 0.812 | 1.060  | 1.495   | 20.30% | 0.364  | 0.00350 | 26.19% / 30.17%   |
| M5    | $236,727     | 8.23%  | $116,704      | 0.904 | 1.151  | 1.640   | 19.55% | 0.421  | 0.00180 | 25.41% / 29.19%   |
| M6    | $190,870     | 6.11%  | $70,846       | 0.881 | 1.218  | 1.741   | 12.70% | 0.481  | 0.00130 | 16.24% / 18.82%   |
| SHY   | $120,024     | 1.69%  | $0            | —     | 1.086  | 1.689   | 5.70%  | 0.296  | 1.00000 | 4.23% / 4.91%     |
| 60/40 | $260,135     | 9.17%  | $140,112      | 0.734 | 0.886  | 1.259   | 21.02% | 0.436  | 0.00260 | 30.08% / 34.03%   |
| SPY   | $421,019     | 14.11% | $300,995      | 0.738 | 0.841  | 1.182   | 33.79% | 0.417  | 0.00160 | 46.84% / 52.12%   |

### Fixed notional

| Mix   | Final equity | CAGR  | Excess vs SHY | IR    | Sharpe | Sortino | MaxDD  | Calmar | p       | DD VaR / CVaR 95% |
| ----- | ------------ | ----- | ------------- | ----- | ------ | ------- | ------ | ------ | ------- | ----------------- |
| M1    | $166,040     | 4.76% | $47,656       | 0.646 | 0.898  | 1.239   | 17.04% | 0.280  | 0.01800 | 23.39% / 28.26%   |
| M2    | $180,830     | 5.59% | $62,446       | 0.955 | 1.189  | 1.902   | 7.09%  | 0.788  | 0.00030 | 10.70% / 12.70%   |
| M3    | $152,738     | 3.96% | $34,354       | 0.578 | 0.848  | 1.328   | 8.12%  | 0.488  | 0.01690 | 13.04% / 15.41%   |
| M4    | $182,207     | 5.66% | $63,823       | 0.826 | 1.066  | 1.534   | 16.54% | 0.342  | 0.00310 | 21.54% / 25.87%   |
| M5    | $196,059     | 6.37% | $77,675       | 0.904 | 1.119  | 1.656   | 16.37% | 0.389  | 0.00120 | 21.21% / 25.38%   |
| M6    | $169,969     | 4.99% | $51,585       | 0.853 | 1.147  | 1.653   | 10.17% | 0.490  | 0.00140 | 14.20% / 16.88%   |
| SHY   | $118,384     | 1.56% | $0            | —     | 1.086  | 1.689   | 5.38%  | 0.290  | 1.00000 | 3.97% / 4.66%     |
| 60/40 | $201,672     | 6.65% | $83,288       | 0.734 | 0.886  | 1.259   | 14.38% | 0.463  | 0.00260 | 25.76% / 30.91%   |
| SPY   | $260,593     | 9.19% | $142,209      | 0.738 | 0.841  | 1.182   | 23.78% | 0.387  | 0.00160 | 40.26% / 49.17%   |

## Calendar-year returns

Compounded at 2 bp with SHY carry. Full-period positions are carried through year boundaries; each row is
rebased for a like-for-like return comparison. 2026 ends November 25.

| Year | Sessions | M1     | M2     | M3    | M4     | M5     | M6     | SHY    | 60/40   | SPY     |
| ---- | -------- | ------ | ------ | ----- | ------ | ------ | ------ | ------ | ------- | ------- |
| 2016 | 252      | 0.61%  | -0.99% | 4.69% | 1.32%  | -0.86% | 2.09%  | 0.62%  | 8.27%   | 13.29%  |
| 2017 | 251      | 8.70%  | 4.59%  | 0.59% | 9.77%  | 11.47% | 11.33% | 0.26%  | 13.79%  | 21.75%  |
| 2018 | 251      | 0.37%  | 7.81%  | 7.67% | 0.04%  | -0.05% | 1.85%  | 1.46%  | -2.21%  | -4.96%  |
| 2019 | 252      | 12.48% | 4.04%  | 2.88% | 13.06% | 12.34% | 8.14%  | 3.39%  | 21.71%  | 31.14%  |
| 2020 | 253      | 0.91%  | 8.62%  | 3.44% | 5.51%  | 7.85%  | 5.40%  | 3.03%  | 16.85%  | 18.45%  |
| 2021 | 252      | 8.01%  | 4.68%  | 5.37% | 11.94% | 14.14% | 8.98%  | -0.71% | 15.01%  | 28.60%  |
| 2022 | 251      | 5.48%  | 5.23%  | 1.23% | 3.55%  | 10.10% | 3.09%  | -3.88% | -16.38% | -18.18% |
| 2023 | 250      | 6.73%  | 5.19%  | 5.22% | 7.68%  | 5.83%  | 9.27%  | 4.17%  | 16.98%  | 26.18%  |
| 2024 | 252      | 7.53%  | 6.54%  | 4.55% | 10.03% | 10.73% | 9.11%  | 3.92%  | 14.24%  | 24.89%  |
| 2025 | 250      | 13.26% | 7.36%  | 6.99% | 13.75% | 13.67% | 6.47%  | 4.95%  | 14.31%  | 17.72%  |
| 2026 | 227      | 3.43%  | 3.99%  | 1.34% | 4.83%  | 5.66%  | 1.45%  | 1.54%  | 3.36%   | 5.93%   |

## Split returns

Compounded total return and excess vs SHY at 2 bp with SHY carry.

| Mix   | 2016–2021 return / excess | 2022–2023 return / excess | 2024–2026 return / excess |
| ----- | ------------------------- | ------------------------- | ------------------------- |
| M1    | 34.58% / 26.33%           | 12.58% / 12.46%           | 25.96% / 15.22%           |
| M2    | 32.07% / 23.82%           | 10.69% / 10.57%           | 18.95% / 8.20%            |
| M3    | 27.14% / 18.90%           | 6.52% / 6.39%             | 13.36% / 2.62%            |
| M4    | 48.58% / 40.33%           | 11.50% / 11.38%           | 31.22% / 20.47%           |
| M5    | 52.76% / 44.52%           | 16.52% / 16.39%           | 33.00% / 22.25%           |
| M6    | 43.79% / 35.54%           | 12.64% / 12.52%           | 17.85% / 7.10%            |
| SHY   | 8.25% / 0.00%             | 0.12% / 0.00%             | 10.74% / 0.00%            |
| 60/40 | 97.05% / 88.80%           | -2.19% / -2.31%           | 34.97% / 24.23%           |
| SPY   | 161.86% / 153.62%         | 3.24% / 3.12%             | 55.73% / 44.98%           |

## Crisis-year attribution

Actual ledger dollars (not rebased percentages), compounded, 2 bp with SHY carry. O1 and O2 include
explicit SHY signal positions; the sweep column is idle-cash SHY only. Execution costs and financing are separate.

| Year | Mix | O1     | O2     | Intraday | Sweep   | Slippage | Sell fee | Borrow | Debit | Net     |
| ---- | --- | ------ | ------ | -------- | ------- | -------- | -------- | ------ | ----- | ------- |
| 2018 | M4  | $586   | $0     | $115     | $38     | −$621    | −$65     | $0     | −$6   | $46     |
| 2018 | M5  | $984   | $0     | $268     | $5      | −$1,180  | −$124    | $0     | −$6   | −$52    |
| 2018 | M6  | $209   | $1,125 | $1,331   | $462    | −$824    | −$87     | −$111  | −$0   | $2,104  |
| 2020 | M4  | $4,181 | $0     | $3,269   | $78     | −$531    | −$56     | $0     | −$8   | $6,933  |
| 2020 | M5  | $4,531 | $0     | $6,209   | $80     | −$966    | −$101    | $0     | −$11  | $9,741  |
| 2020 | M6  | $1,086 | $5,102 | $576     | $672    | −$570    | −$60     | −$30   | −$12  | $6,764  |
| 2022 | M4  | $2,934 | $0     | $2,756   | $118    | −$476    | −$50     | $0     | −$5   | $5,276  |
| 2022 | M5  | $6,378 | $0     | $10,006  | $248    | −$1,093  | −$115    | $0     | −$0   | $15,423 |
| 2022 | M6  | $3,392 | $3,483 | $601     | −$2,120 | −$744    | −$78     | −$93   | $0    | $4,441  |

## Cross-horizon correlation

Matched-session Pearson correlation using independent base 2 bp ledgers: O1 compounds with SHY; O2
uses fixed notional with SHY; I1/I2 use fixed notional without SHY. All warm-up and cash sessions remain.
Benchmarks are adjusted total-return series. The drawdown subset uses SPY below its running total-return
high-water mark at the close (including positive days spent below that mark, not just negative SPY days).

### All sessions (2,741)

| Engine | O1     | O2     | I1     | I2     | SPY    | IEF    | GLD   | SHY    |
| ------ | ------ | ------ | ------ | ------ | ------ | ------ | ----- | ------ |
| O1     | 1.000  | 0.596  | -0.022 | -0.035 | 0.625  | 0.099  | 0.395 | 0.081  |
| O2     | 0.596  | 1.000  | -0.043 | -0.050 | 0.526  | 0.178  | 0.230 | 0.185  |
| I1     | -0.022 | -0.043 | 1.000  | 0.868  | -0.038 | 0.025  | 0.006 | 0.024  |
| I2     | -0.035 | -0.050 | 0.868  | 1.000  | -0.060 | 0.024  | 0.022 | 0.027  |
| SPY    | 0.625  | 0.526  | -0.038 | -0.060 | 1.000  | -0.120 | 0.105 | -0.056 |
| IEF    | 0.099  | 0.178  | 0.025  | 0.024  | -0.120 | 1.000  | 0.312 | 0.813  |
| GLD    | 0.395  | 0.230  | 0.006  | 0.022  | 0.105  | 0.312  | 1.000 | 0.323  |
| SHY    | 0.081  | 0.185  | 0.024  | 0.027  | -0.056 | 0.813  | 0.323 | 1.000  |

### SPY drawdown sessions (2,318)

| Engine | O1     | O2     | I1     | I2     | SPY    | IEF    | GLD    | SHY    |
| ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ |
| O1     | 1.000  | 0.583  | -0.047 | -0.066 | 0.620  | 0.083  | 0.389  | 0.064  |
| O2     | 0.583  | 1.000  | -0.077 | -0.093 | 0.513  | 0.168  | 0.230  | 0.173  |
| I1     | -0.047 | -0.077 | 1.000  | 0.872  | -0.059 | 0.025  | -0.009 | 0.025  |
| I2     | -0.066 | -0.093 | 0.872  | 1.000  | -0.089 | 0.027  | 0.012  | 0.029  |
| SPY    | 0.620  | 0.513  | -0.059 | -0.089 | 1.000  | -0.127 | 0.107  | -0.064 |
| IEF    | 0.083  | 0.168  | 0.025  | 0.027  | -0.127 | 1.000  | 0.292  | 0.815  |
| GLD    | 0.389  | 0.230  | -0.009 | 0.012  | 0.107  | 0.292  | 1.000  | 0.307  |
| SHY    | 0.064  | 0.173  | 0.025  | 0.029  | -0.064 | 0.815  | 0.307  | 1.000  |

## Friction and carry sensitivity

Each cell is exact-span CAGR / full-period information ratio vs SHY (rounded for display). All 96 accounts
and their 10,000-trial results are in the JSON; the table highlights compounded paths.

| Mix | Carry | 1 bp          | 2 bp          | 5 bp            | 10 bp           |
| --- | ----- | ------------- | ------------- | --------------- | --------------- |
| M1  | SHY   | 6.13% / 0.666 | 6.11% / 0.662 | 6.05% / 0.652   | 5.93% / 0.634   |
| M1  | zero  | 6.10% / 0.648 | 5.91% / 0.625 | 5.84% / 0.614   | 5.74% / 0.599   |
| M2  | SHY   | 5.58% / 0.941 | 5.21% / 0.805 | 3.77% / 0.414   | -0.22% / -0.261 |
| M2  | zero  | 7.23% / 0.811 | 6.14% / 0.661 | 3.02% / 0.222   | -1.99% / -0.514 |
| M3  | SHY   | 4.43% / 0.699 | 4.01% / 0.561 | 1.67% / 0.023   | -4.79% / -1.088 |
| M3  | zero  | 4.37% / 0.437 | 3.02% / 0.232 | -0.91% / -0.378 | -7.17% / -1.408 |
| M4  | SHY   | 7.60% / 0.846 | 7.39% / 0.812 | 6.71% / 0.704   | 5.55% / 0.538   |
| M4  | zero  | 7.98% / 0.892 | 7.54% / 0.816 | 6.90% / 0.716   | 5.67% / 0.549   |
| M5  | SHY   | 8.39% / 0.933 | 8.23% / 0.904 | 6.87% / 0.692   | 5.27% / 0.467   |
| M5  | zero  | 8.68% / 0.940 | 8.32% / 0.888 | 7.19% / 0.715   | 5.21% / 0.456   |
| M6  | SHY   | 6.31% / 0.931 | 6.11% / 0.881 | 5.44% / 0.725   | 3.87% / 0.408   |
| M6  | zero  | 6.68% / 0.881 | 6.30% / 0.805 | 5.35% / 0.649   | 3.91% / 0.406   |

## Reproduce the evidence

Download these objects from the authorized `agents-artifacts` bucket. The exact prefixes, file names, byte
counts and checksums are listed in [the input receipt](results.json). Supply the local names below; the CLI
uses no credentials and does not contact S3 or market data services.

| Local filename                            | Source                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `daily.json`, `daily.gz`                  | SIP 10yr SP100 manifest + daily adjusted archive                                                 |
| `macro.json`, `macro.gz`                  | SIP DIA/UUP supplemental manifest + daily adjusted archive                                       |
| `blind.json`, `blind.gz`, `calendar.json` | SIP 8yr 5m unseen-v2 manifest, corrected tape and 2016–2023 calendar                             |
| `recent.json`, `recent.gz`                | SIP multiyear manifest + 2024–2026 5m archive                                                    |
| `recent-calendar.json`                    | `bayn-research-datasets/2026-11-27/calendar_2024_2026.json` (Wave 5A's pinned separate calendar) |

From the repository root:

```sh
bun services/bayn/tools/research-10yr-pure-etf-dual-horizon.ts \
  --data-dir /path/to/frozen-inputs --output /tmp/wave6c-results.json --ledger-dir /tmp/wave6c-ledgers
bunx oxfmt --write /tmp/wave6c-results.json
cmp /tmp/wave6c-results.json docs/bayn/evidence/2026-11-27-10yr-pure-etf-dual-horizon/results.json
```

The optional ledger directory retains every date, gross cap, maintenance-derived DTBP, attributed P&L, opening
sleeve exposures, closing signed notionals, and each filled round trip. The JSON reports deterministic byte
hashes for the four standalone and 96 portfolio ledgers. The ledger directory is not required to reproduce
the report. No raw tapes or broker account data are committed.

## Disposition

This synthesis is retrospective, even though C5 has an earlier blind result. Prior fold labels describe the
upstream research and do not make the combined book out of sample. Keep the mixes, sleeve parameters and
eligibility frozen for a **prospective 120-session paper/shadow validation** against observed quotes, fills,
borrow and buying power before any live-capital consideration. Historical results do not grant execution
or capital authority and do not change Bayn's deployed defaults.
