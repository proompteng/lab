# Wave 4G registration: overnight vs. intraday

**Research only.** No runtime changes, capital approval, or orders. The hypotheses are motivated by
[Lou, Polk & Skouras, JFE 134 (2019), 192–213](https://doi.org/10.1016/j.jfineco.2019.03.011):
past overnight performance may predict subsequent overnight returns and reverse during the day. This is
a bounded, short-horizon survivorship-conditioned study, not a replication of the paper's full cross-section
or proof of a causal clientele mechanism.

## Data and freeze

- Use the frozen Alpaca SIP `adjustment=all` daily OHLCV gzip and `MANIFEST.json` under
  `agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/`. Manifest, compressed and raw SHA-256,
  the row key, unique ticker-date keys, OHLCV, calendar endpoints and exact counts are verified. The source
  contract is 450,712 rows / 2,741 sessions. Do not substitute another market-data feed or commit the tape.
- Train: Jan 4, 2016–Dec 31, 2021 (1,511 sessions); Validation: Jan 3, 2022–Dec 29, 2023 (501);
  Holdout: Jan 2, 2024–Nov 25, 2026 (729). Development hashes the opaque gzip for identity and projects the
  decompressed rows by date before decoding any post-Validation prices, volume or symbols. Signal warmup and
  rebalance state pass forward across split boundaries; returns and both transaction legs are booked on exit date.
  No new overnight entry on the last observed date of a run. First-day close-to-close benchmark returns are zero
  because the preceding close is not in the sample.
- The manifest sector lists contain 138 S&P 100-related large caps across 11 sectors (not historical index
  membership). Exclude MMC everywhere, not just after its Jan 2026 ticker change; do not splice MRSH. The remaining
  137 names are the configured set, not all continuously observed: LIN starts later in this tape. The 27 ETFs
  include XLC only after listing observations accrue. The run never infers a last trading date from absence of
  future data. Consecutive windows reset at missing observations; no stale-price signals or returns over missing
  windows. The fixed list, back-adjusted/rounded prices, and absence of historical borrow/liquidity and actual
  exchange auction records are important limits on generalization.
- Define and run **44 standalone configurations + 1 ensemble at 4 costs = 180 trial cells**, including the eight
  same-open diagnostics (32 cells). Calendar cuts, omission checks and untraded asset-level decomposition do
  not generate candidates or count as tunable trials. Publish the protocol, engine, and development receipt to
  the named branch before `--score`. Score verifies local and fetched branch ancestry, exact committed receipt
  bytes, and a replay of the development signature before decoding Holdout prices. No Holdout-based redesign,
  refit, DSR recalibration, benchmark changes, reprioritization of ensemble legs, or selective result suppression.

## Entry and exit contract

Use signed fixed-`$100,000` gross target capital (100% long, or 50% long plus 50% short); no reinvestment and
no cash yield credited to idle strategy capital. Size shares at the previous available **adjacent session close**,
not the execution price. Weights are dollar-neutral at that reference price; realized dollar exposure may drift.
Fills are the bar's open/close as auction-price **proxies**, not guaranteed matched orders. The official
[NYSE](https://www.nyse.com/trade/auctions) and [Nasdaq](https://nasdaqtrader.com/Trader.aspx?id=OpenClose)
procedures take auction orders before the print. Final open can never choose a MOO fill at that print; final close
can never choose a MOC fill at that print. A signal based on pre-cutoff indicative auction data would be a different
experiment; daily bars do not contain those data. Do not infer zero crossing cost, exchange/broker availability,
locates, realized 2 bp fills, or orthogonality to Bayn's strategies from this tape.

Reference-share entry is modeled at the order session's close for overnight or open for intraday. Exit at next
session open for overnight or same-session close for intraday. A missing entry print is a reported nonfill; a
missing scheduled exit leaves shares pending until the next matching print, with no replacement on that name.
A close known in advance as a symbol's final liquidity event overrides a due exit at that day's last close and
forbids entry there or later. This path is tested independently and no known-exit override is used on the real tape
(MMC is excluded). Overdue positions are counted and fail the advancement gate; no zero-return fill, stale mark,
or silent exclusion of the affected date. Economic aggregates for a path ending with an overdue position represent
settled trades only and must not be interpreted as a terminal valuation.

## Registered grid

1. **Persistence (18):** sum adjacent daily log overnight `ln(O_t/C_{t-1})` and intraday `ln(C_t/O_t)` returns
   over each 20, 60 and 120 sessions. Rank by overnight or by overnight minus intraday. For all six combinations,
   run top-minus-bottom deciles both universe-wide and sector-neutral. Sector mode ranks independently and allocates
   equal gross budgets by sector; unused budgets remain cash. The number per tail is the ceiling of pool size/10,
   capped at half the eligible pool. Add daily long-only universe overnight for all three lengths, long-only
   universe overnight L=60 at 5- and 10-session refresh, and long-only sector spread L=60 daily. Ties break by
   symbol. At the close on day d, the latest decision features are through d−1. Slower refresh caches names on
   fixed session indices; every open still flattens and new MOC/MOO round trips pay all costs, so it reduces
   ranking churn, not necessarily auction notional. The matched gross opposite intraday P&L uses the exact
   on-time overnight share positions from the exit-day open to that day's close, for sign comparison only.
2. **Gap (16):** cross fade/continuation × universe/sector center × 1.5/2.0 absolute standardized gap × two signal
   timings. Compute log gap relative to the cross-sectional median, then divide by the asset's sample volatility
   of 20 prior log gaps (excludes the signal price). Fade buys negative and shorts positive tails; continuation
   does the opposite but requires the centered gap's sign to agree with prior close relative to its 50-day SMA,
   and previous completed daily volume to be at least 1.2× its preceding 20-session mean. No current-session
   cumulative volume or close may affect an open decision. Select equally many qualifying names on each side,
   strongest first, at most a decile per side; with no two-sided opportunity the group stays flat. **Same-open**
   uses day d's final opening price and is untradeable at that price. **Prior-gap** uses the identical day d−1
   gap construction for day d MOO; this is a distinct executable-timing hypothesis, not a fill for same-day alpha.
3. **ETF premium (10):** equal-weight all 27 or the eight anchors SPY, QQQ, IWM, TLT, GLD, HYG, EFA, EEM, with
   unfiltered MOC→MOO and MOO→MOC portfolios for each universe. Add overnight-only per-asset SMA50/100/200 for
   all and SMA100 for anchors, and overnight-only HYG-close-above-own-SMA100 (a credit-risk proxy, not isolated
   credit spread) for both universes. Filters see only through d−1 at the order. A name requires 20 consecutive
   prior completed observations and sufficient SMA history for its rule. Filtered-out weights sit idle, not
   redistributed. For each of 27 ETFs separately, also show _untraded_ paired session decomposition on adjacent
   observations after the same 20-day warmup: compounded log segments and close-close, annualized volatility of
   simple segment returns, and summed segment return on down-SPY days. Overnight and intraday are multiplicative,
   not generally additive.
4. **Ensemble (1):** for each of Families 1–3 select the timing-eligible member maximizing the lesser of Train
   and Validation annualized Sharpe of 2 bp daily net minus SHY. Break ties by ascending ID. Fit positive
   equal-risk-contribution weights to Train 2 bp net daily covariance, with 1e−6 times the largest diagonal as
   a ridge. Freeze members and weights; combine standalone transaction-ledger legs without crossing or netting
   costs. No other ensembles are tried.

## Accounting, inference and decision

- Split round-trip costs 2 / 5 / 10 / 20 bp half per side on actual executed gross notional, plus 0.21 bp on each
  sale (entry for a short) and 1.5% annualized short borrow on entry notional, ACT/365 elapsed calendar days with
  a conservative one-day minimum (including intraday shorts). Two bp is the modeled low-cost auction case,
  not an estimate measured here; 5 bp is moderate and 10/20 bp are stress.
- Each split and calendar year reports daily fixed-capital net USD, ex-top-five and ex-top-ten ranked net days,
  ordinary and excess annualized Sharpe (sample deviation, 252 sessions), max peak-to-trough drawdown from $100k,
  linear annualized-return / max drawdown Calmar, net SPY close-to-close beta and USD P&L on down-SPY days,
  one-way turnover (absolute buys plus sales divided by twice capital, per session and annualized), and
  fixed-base excess return versus fully deployed SHY adjusted close-to-close without modeled fees. Section
  years 2016 and 2026 reflect the observed sample only, not forward-filled years.
- For each split / cost, remove each sector for stock strategies or each ETF for multi-asset strategies and
  rerun ranks, sizing and execution. The ensemble retains frozen legs and weights and removes the group from
  its owning sleeves. Benchmark and HYG's role as a credit indicator are held constant; removing a nonmember
  can legitimately yield no effect. Report omitted net, excess, Sharpe and delta net. Plateau is the percent
  of same-family neighbors differing in exactly one grid field other than timing (not including the focal
  cell) with positive net, SHY excess and ex-top-five net; for the ensemble use its three frozen constituents.
- Use a one-sided, mean-centered [stationary bootstrap](https://doi.org/10.1080/01621459.1994.10476870)
  of daily SHY-excess P&L separately per split, 10,000 circular draws, uniformly random block starts,
  geometrically distributed lengths with mean 10 sessions, fixed seed, and plus-one rank correction. Report raw
  p and Holm step-down adjustment across all 180 cells in each split. Use daily excess Sharpe in the
  [Deflated Sharpe Ratio](https://ssrn.com/abstract=2460551) with skew and non-excess kurtosis, and calibrate the
  expected maximum null Sharpe from the cross-trial Train daily-Sharpe sample deviation and all 180 trials
  via the standard Euler–Mascheroni approximation. Keep that reference fixed on Validation and Holdout; DSR
  does not on its own correct for serial dependence, hence the separate block test.
- A candidate may advance to independent auction data evaluation only if timing-eligible, with positive net,
  SHY excess and ex-top-five net in **every split at 2, 5 and 10 bp**; both Validation and Holdout at 2 bp must
  have Holm p ≤ 0.05 and DSR ≥ 0.95; 2 bp plateau ≥ 50% in all splits; ≥ 80% of Holdout 2 bp omissions must
  retain positive net and SHY excess; and no overdue position in any split. Report 20 bp as stress, not an
  alternate or additional selection gate. Passing would not establish a real fill, live alpha, economically
  independent Bayn exposure or trading authorization.
