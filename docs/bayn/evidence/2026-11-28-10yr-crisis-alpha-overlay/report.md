# Wave 21M: 10-year crisis-alpha overlay

## Preregistered protocol

**Question.** Can a long-only, daily, next-open ETF sleeve meaningfully improve the worst-quarter and 2020/2022 drawdowns of B0 + F4 + O1 without giving up net CAGR or Sharpe? This is a historical research experiment, not a trading authorization.

### Evidence and allocation

- The overlay and SPY benchmark may use only the requested ETFs in the authenticated
  `agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/` manifest and its daily adjusted SIP tape.
  Require SPY and QQQ plus at least one requested haven. UUP is absent from that manifest; exclude it without a
  proxy, even though it exists in a different object used by the unchanged macro references. Require an
  observed open and close for every admitted symbol on every registered session. Never forward-fill.
- The baseline uses the fixed Wave 9B B0 QQQ/SMH Noise Area signal and Wave 17-9's signed whole-share
  B0 sizing, and separate whole-share F4 and O1 books run by the Wave 8A account replay. Reuse the original
  QQQ/SMH five-minute SIP archives for B0 and the registered daily DIA/UUP companion for F4/O1 only. Check
  B0's fixed-size replay and the F4/O1 signal identities against their upstream receipts. Missing B0 entry
  prints are counted and do not fill. An unresolved exit aborts; a held-bar gap on a scored date blocks promotion.
- Run those references from the first archive session at $100k **each**, preserving their own capital caps,
  sizing and state. At the start of the scored period take normalized stakes of 40% B0, 35% F4, 25% O1.
  Aggregate their independently compounded marks without cross-account trades or rebalancing. This is a
  reference mix, not a replay of the published $40k/$35k/$25k account allocation with those starting balances.
  SPY is a passive adjusted-price benchmark, already held at the scoring boundary, with no mid-study trades.
- For each overlay arm replace 25% of the initial reference mix with a separately funded fractional ETF sleeve.
  The 75% reference stake stays intact; subsequent sleeve weights drift. This tests a funded capital replacement,
  not a levered add-on or live transfer. The equal SPY/QQQ static arm isolates the cost of substituting an equity
  sleeve for base capital. The cash control tests the same primary switch without purchasing havens.

### Rules and execution

- From completed closes only, calculate SPY's 200-session simple moving average and its 20-session sample
  standard deviation of close-to-close log returns, annualized by √252. A break is close strictly below the
  moving average; high realized volatility is at least 20%.
- The fixed **primary** goes defensive on **either** trigger. A diagnostic goes defensive only on **both**.
  In offense use equal SPY/QQQ. In defense use equal weights among admitted GLD, TLT, IEF, SHY and DBC whose
  own close is strictly above its 63-session simple moving average. If none qualifies, hold idle cash with
  zero credited interest. The cash control uses no havens; the static control always targets offense.
  No tuning, model fitting, fold-dependent winner selection, or alternative rules after scoring.
- Review after each completed close. Rebalance at the next recorded open only if required one-way replacement
  at the prior close is at least 10 percentage points (greater of target buys and sells, including implicit cash).
  Fund the sleeve in cash before its first scored open and use the same rule from inception. In-band positions
  retain exact shares. Old holdings receive the overnight gap, new holdings the open-to-close move. Size
  fractional targets on post-fee opening equity; no shorts, borrowing, intraday fills, or terminal liquidation.
- Stress **0 / 2 / 5 / 10 bp one-way**, consistently across the traded reference accounts and ETF sleeve,
  plus the existing 0.21 bp fee on sell proceeds at every tier. Zero means no modeled slippage, not no fees.
  Report realized overlay turnover as traded ETF notional divided by twice opening sleeve equity, annualized
  over 252 sessions. These are friction scenarios, not measured auction fills, spreads or market impact.

### OOS and decision

The calendar spans 2016-01-04 through 2026-11-25. Use 2016-01-04 through 2016-10-31 for initial history.
Score fixed rules continuously and report consecutive walk-forward folds, with only past state carried
into each later day: **2016-11-01–2019-12-31**, **2020-01-02–2021-12-31**, **2022-01-03–2023-12-29**,
**2024-01-02–2026-11-25**. OOS means decisions were out of sample with respect to their inputs,
not that this already-studied historical tape was blind or prospectively reserved.

- Report compounded net, calendar-time CAGR, annualized daily Sharpe (zero risk-free rate), and close-marked
  peak-to-trough MaxDD. Reset each reporting window's high-water mark to its opening equity (preceding close);
  do not reset holdings. Find worst compounded-return and worst MaxDD calendar quarters among complete
  quarters (exclude 2016 Q4 and 2026 Q4); also compare all books in the baseline's worst MaxDD quarter.
- Report 2020-02-19 through 2020-04-30 (COVID selloff and partial recovery) and 2022-01-03 through 2022-12-30
  (full bear year). These dates are retrospective labels, not signal inputs. Attribute the baseline's ten
  worst individual sessions and its worst contiguous ten-session window on the same dates for all arms.
  Within each crisis, break out ETF contributions and fees by the regime held after the open; overnight
  price moves always use the old inventory. Arithmetic daily contributions are not compounded excess.
- Pair realized primary/base daily returns in a circular stationary block bootstrap (2,000 draws, mean
  block 10 sessions, xorshift seed `0x21a2026`). For the stitched OOS period report central 95% percentile
  intervals for net CAGR and Sharpe differences and baseline-minus-primary MaxDD. The resampling measures
  sensitivity to clustered observed returns; it does not manufacture independent crisis episodes.
- **PROMOTE** only if the primary meets all of these at **both 5 and 10 bp**: no loss of net OOS CAGR or
  Sharpe, and at least **1 percentage point** lower MaxDD for its own worst complete quarter and for
  each crisis window. Also require a strictly positive 5 bp paired bootstrap lower bound for OOS MaxDD
  improvement and no scored B0 held-bar gaps. Otherwise **DO NOT PROMOTE**. The other arms are diagnostic
  and cannot rescue a failed primary. A pass would only warrant further prospective research.

## Results — DO NOT PROMOTE

The primary raised net CAGR from **4.98% to 6.38%** at 5 bp one-way, but lowered Sharpe from **1.040 to 0.957**.
It deepened worst-quarter and COVID MaxDD from **8.24% to 9.32%**, and 2022 MaxDD from **4.02% to 7.36%**.
All three tail gates failed at every cost, including zero slippage. The binding failure was the allocation's
drawdown, not assumed trading friction. This result rejects the registered funded switch, not every possible hedge.

### Data and replay readback

[Protocol commit](https://github.com/proompteng/lab/commit/9c11ab24c76989a7a18b9f3af9353326885dfe36) was pushed
before any replay. [Machine-readable results](results.json) retain the exact archive, calendar and signal receipts.
The base daily manifest and compressed and decoded object hashes matched. The archive provided **2,741** observed
open/close pairs per admitted ETF (SPY, QQQ, GLD, TLT, IEF, SHY, DBC); **UUP was not listed and never entered the
overlay**. The calendar spans 10.89 years, of which **2,531** consecutive sessions (**10.07 years**) were scored
after **210** warm-up sessions.

B0 replayed **8,641,719** older and **3,923,737** recent five-minute data rows. Its upstream fixed-size comparator
matched **$103,533.58 / $69,780.16** at 2 / 5 bp **round-trip** to the cent; these identity checks are not the
study's dynamic reference returns below. There were no missing B0 entry prints on the registered signal path and
no unresolved exit. The one observed held-bar gap, 2016-02-02, was outside the scored period; the book had an
observed exit but the missing mark still limits certainty about that warm-up trade's path. The **63 F4** and
**119 O1** review vectors matched their Wave 8A signal hashes.

### 5 bp one-way: scored portfolio and tail comparisons

| Book           |   CAGR | Sharpe | OOS MaxDD | Worst quarterly net | Worst-quarter MaxDD | COVID MaxDD | 2022 MaxDD |
| -------------- | -----: | -----: | --------: | ------------------: | ------------------: | ----------: | ---------: |
| SPY            | 14.56% |  0.853 |    33.79% |    −19.57% (2020Q1) |     33.79% (2020Q1) |      33.79% |     24.50% |
| B0             |  1.96% |  0.269 |    18.11% |     −5.42% (2025Q3) |      8.66% (2020Q2) |       0.95% |      7.26% |
| F4             |  6.82% |  1.242 |     9.81% |     −4.53% (2022Q2) |      9.81% (2020Q1) |       9.81% |      5.48% |
| O1             |  6.36% |  0.911 |    20.61% |    −11.69% (2020Q1) |     20.61% (2020Q1) |      20.61% |      6.01% |
| B0 + F4 + O1   |  4.98% |  1.040 |     8.24% |     −2.11% (2020Q1) |      8.24% (2020Q1) |       8.24% |      4.02% |
| Primary OR     |  6.38% |  0.957 |     9.32% |     −4.33% (2018Q4) |      9.32% (2020Q1) |       9.32% |      7.36% |
| Diagnostic AND |  8.00% |  1.026 |    15.14% |     −7.61% (2020Q1) |     15.14% (2020Q1) |      15.14% |      8.50% |
| Cash switch    |  6.57% |  1.066 |     8.15% |     −4.51% (2018Q4) |      8.15% (2020Q1) |       8.15% |      5.86% |
| Static offense |  9.27% |  0.955 |    15.46% |     −9.63% (2022Q2) |     15.46% (2020Q1) |      15.46% |     13.03% |

The baseline's worst MaxDD quarter was 2020Q1; it was also the primary's worst, so matched and own worst-quarter
comparisons agree. The static arm confirms that switching reduced the losses of a standing equity allocation.
That does not make the added sleeve a hedge for the existing book. Even the cash switch, which beat the primary
on both full-period economics and both crisis drawdowns at 5 bp, exceeded the base's 2022 drawdown.

| Walk-forward fold | Sessions | CAGR, base → primary | Sharpe, base → primary | MaxDD, base → primary |
| ----------------- | -------: | -------------------: | ---------------------: | --------------------: |
| 2016–2019         |      796 |        2.75% → 4.83% |          0.740 → 0.972 |         4.21% → 5.78% |
| 2020–2021         |      505 |        4.02% → 7.75% |          0.724 → 1.050 |         8.24% → 9.32% |
| 2022–2023         |      501 |        4.97% → 3.70% |          0.956 → 0.509 |         4.02% → 7.36% |
| 2024–2026         |      729 |        8.20% → 9.09% |          1.648 → 1.254 |         3.86% → 6.28% |

### Cost and inference

Positive MaxDD deltas below mean **more** drawdown for the primary. The 0 bp tier still charges the sell fee.

| One-way cost (bp) | CAGR, base → primary | Sharpe, base → primary | Δ worst-quarter MaxDD (pp) | Δ COVID MaxDD (pp) | Δ 2022 MaxDD (pp) |
| ----------------: | -------------------: | ---------------------: | -------------------------: | -----------------: | ----------------: |
|                 0 |        8.90% → 9.46% |          1.818 → 1.501 |                      +1.27 |              +1.27 |             +2.48 |
|                 2 |        7.50% → 8.33% |          1.487 → 1.275 |                      +1.27 |              +1.27 |             +2.61 |
|                 5 |        4.98% → 6.38% |          1.040 → 0.957 |                      +1.08 |              +1.08 |             +3.33 |
|                10 |        2.83% → 4.56% |          0.594 → 0.663 |                      +0.72 |              +0.72 |             +6.15 |

The 10 bp relative Sharpe flip comes with lower absolute Sharpe in **both** portfolios. The cost sensitivity of B0
is visible in its **1.96%** CAGR at 5 bp versus **−8.00%** at 10 bp; the higher relative overlay Sharpe is not
evidence of better crisis protection. The 5 bp sleeve placed orders on **185** sessions, turned over **10.85×** of
its sleeve equity per year one-way, and drifted to a **31.46% mean start-of-day share** of the funded portfolio.
These are modeled turnover and allocation, not executable liquidity. The deadband reduces small drift trades,
not changes between offense and defense or changes in which havens qualify.

At 5 bp, the paired 95% intervals were **[−1.15, +4.11] pp** for CAGR difference,
**[−0.457, +0.320]** for Sharpe difference, and **[−9.46, +1.03] pp** for baseline-minus-primary OOS MaxDD.
The study failed the positive lower-bound gate. Inference is limited by one realized path and two crisis
episodes; reusing its clustered observations in 2,000 draws does not add independent crises.

### Where the tails came from

- **COVID (51 sessions, 5 bp):** The primary spent 46 sessions defensive after the open.
  Its SPY and QQQ contributions over the five offense sessions totaled **−2.39 pp** of portfolio return.
  On defensive sessions TLT and IEF contributed **+0.99 pp** together, partly offset by GLD (**−0.63 pp**).
  The drawdown remained worse than the already diversified baseline.
- **2022 (251 sessions, 5 bp):** The primary spent 223 sessions defensive after the open; getting defensive was
  not enough. IEF and TLT took **−1.67 pp** together in those sessions, more than offsetting GLD and DBC's
  **+0.96 pp**. Defensive-session trading fees took another **0.94 pp**. These are arithmetic contributions to
  the whole portfolio; the JSON retains old-inventory gaps, other holdings and fees in the corresponding
  regime totals, not an assumed decomposition of compound returns.
- **Matched tail days (5 bp):** On the base's ten worst individual days, net returns summed to **−15.35%** for
  base versus **−14.19%** for primary and **−13.22%** for the cash control. On the baseline's worst
  contiguous stretch (March 5–18, 2020), the compounded loss was **−7.68%** for base, **−7.11%** for primary,
  and **−5.40%** for cash. Gains on a subset of days did not prevent deeper losses from a high-water mark
  over the complete quarter or crisis. The JSON compares all books on those same days and the contiguous window.

### Reproduce

From the repository root, on a runner with read-only access to the existing Rook-Ceph archive:

```sh
bun services/bayn/tools/research-10yr-crisis-alpha-overlay.ts --output /tmp/bayn-w21m-results.json
```

Use a new destination. The runner does not update freezes, contact a broker, or access a production trading
account. Compare the parsed output to [results.json](results.json); the committed copy is repository-formatted.
Five real-tape prefixes reproduced the identical decisions and 5 bp ledger prefixes for all four arms.
Replacing the March 16, 2020 execution candle with another archived observation for a causality check left
its signal unchanged; this substitution was not used in scoring.

The model is limited to archived adjusted daily and five-minute marks. A completed bar is not evidence of
point-in-time corporate-action knowledge, auction fills, intraday drawdown minima, borrow availability or
execution capacity. The roster and crisis dates are retrospective. No result here changes Bayn policy or
grants research, Paper, or live execution authority.
