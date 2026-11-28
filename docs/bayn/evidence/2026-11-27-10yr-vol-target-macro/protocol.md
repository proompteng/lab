# Wave 19F preregistration: volatility-targeted cross-asset trend

## Question and data

Can a funded, long/flat ETF trend sleeve improve net Sharpe and drawdown when it replaces 25% of the
equal-capital B0/F4/O1 stack? Also test it alone against SHY and at a 25% allocation alongside each
incumbent separately. Report SPY as a passive market comparator, not as a trial or a promotion hurdle.

- Use the hash-pinned, total-return-adjusted Alpaca SIP daily SP100/ETF archive and DIA/UUP supplement.
  The base manifest lists SPY, QQQ, IWM, EFA, EEM, TLT, IEF, GLD, DBC, USO and SHY. Use DBC for broad
  commodities; do not add the narrower USO or switch commodity proxies after seeing returns. SHY is a
  trend-eligible asset, not a default cash sweep. Require every registered trend ticker on every session.
- Use the frozen, split-adjusted 5-minute SIP development and continuity tapes for B0. Match their exact
  session dates to the daily panel. Reproduce [Wave 6A B0](https://github.com/proompteng/lab/pull/16387)
  cents at 2/5 bp round trip by fold, [Wave 5C F4](../2026-11-27-10yr-vol-regime-carry/README.md)
  `F4-42-1-LQD-parity` with its SHY sweep at 10/20 bp round trip by fold, and
  [Wave 5D O1](../2026-11-27-10yr-pure-etf-dual-horizon/README.md)'s original SHY-idle book at
  2/5/10 bp round trip on Full before scoring. Do not replace these with a live policy or an ETF proxy.
- Train: 2016-01-04–2021-12-31 (1,511 sessions); Validation: 2022-01-03–2023-12-29 (501);
  Holdout: 2024-01-02–2026-11-25 (729). Full has 2,741 sessions. The first 253 sessions are
  uninvested warm-up for the trend sleeve; also report a common post-warm-up window for all books.
  Incumbents retain their own warm-up rules. Carry positions across all fold and calendar-year boundaries.
  The Holdout is out of sample for this registration, not an untouched period for the Bayn program.

## Fixed hypotheses and execution

1. At each completed close, average the signs of the 21-, 63-, 126- and 252-session adjusted close returns
   for each asset. Clip negative scores to zero; a zero score has zero target. Divide positive scores by
   trailing 63-session sample volatility of daily simple close returns (annualized, with a 5% floor).
   Normalize to one when any score is positive; otherwise target zero-yield cash.
2. Apply those normalized weights to the same trailing returns to estimate whole-portfolio volatility,
   including covariances. Scale weights by `min(1, target / forecast)` (scale 1 at zero forecast).
   The **8% / 10% / 12%** targets are ceilings on forecast risk when forming a target, not achieved risk
   guarantees. No leverage, shorting or single-asset cap in the trend sleeve.
3. Apply a **0% / 10%** replacement deadband. Compare the whole desired target with the actual holdings
   marked at that same decision close. Replacement is the larger of total positive and absolute negative
   changes in ETF weights (equivalently half the absolute changes including cash). Skip no-change or
   below-band orders; at or above the band, resize the full book at the **next session's open** on
   post-cost equity using fractional shares. Old holdings bear the overnight gap; new ones bear the
   open-to-close move. The opening price sizes the modeled fill, never the signal or band decision.
4. Six trend paths × five allocations = **30 distinct hypotheses**: standalone, 25% trend with 75%
   of B0, of F4, or of O1, and 25% trend with 25% of each incumbent. No fit, selection, or retuning.
   Use the 10%-target/10%-band path as the illustrative case; report all paths. The matched reference
   for each blend is the same incumbent allocation without trend. The stacked reference is equal
   B0/F4/O1. Blend independent sleeve NAV returns, resetting capital shares at the previous-close
   marks with the shared Bayn transfer-cost model. This is a sleeve-level counterfactual, not an
   order-netted or shared-buying-power execution simulation.
5. Stress **0 / 2 / 5 / 10 bp one-way** across the sleeves and transfers. Keep the 0.21 bp sell fee on
   ETF rebalances and B0; “0 bp” means no proportional slippage, not no fees. Keep original B0
   fixed-$100k sizing and normalize daily P&L by that capital before compounding; 20 bp round trip
   is an extrapolation beyond its published cost ladder. Keep original F4 and O1 conventions. Buy passive
   SPY and SHY at the first open, charging the entry rate. Do not liquidate at the sample end.

## Metrics and decision

- Record per-window net compounded return, CAGR, annualized sample volatility and Sharpe (zero risk-free
  rate), Sortino, Calmar, positive MaxDD, and annualized one-way turnover (half the absolute traded
  notional scaled by capital at trade time and averaged × 252). Also report every calendar year's net
  return, including partial 2026. Annualize at 252 sessions. Undefined ratios are null. Report aligned
  daily net Pearson correlations against B0, F4, O1 and SPY for Full and Holdout at every cost.
- At zero slippage, estimate **absolute** one-way breakeven on Full and Holdout: subtract a daily
  surcharge of `2 × observed one-way turnover × bps / 10,000` from each net return until compounded
  wealth reaches 1. Report zero if already nonpositive, “>1,000” if above the calculation bound, and
  not applicable if profitable without trades. This is a fixed-path surcharge estimate, not a
  re-simulation of fills, a forecast of achievable execution costs, or incremental breakeven vs a benchmark.
- On each trial's matched daily net excess returns, compute one-sided
  [stationary bootstrap](https://doi.org/10.1080/01621459.1994.10476870) p for positive mean excess:
  circular geometric blocks of expected length 10, 10,000 draws, shared fixed seed `0x19f2016`,
  centered null and plus-one correction. Full p is descriptive. This tests mean excess, not Sharpe
  or drawdown lift, and the p-values are nominal.
- Compute [Deflated Sharpe](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf) on those same daily
  excess returns. At each cost, compute the expected maximum under a zero-mean null using the
  dispersion of the **30** Train+Validation excess Sharpes after warm-up. Use the exact raw trial count,
  no effective-N discount; cost scenarios and repeated evaluation windows are not new trials.
  Apply that benchmark to Holdout and descriptive Full. This adjustment covers only the Wave 19F
  family, not prior Bayn research, and does not remove serial dependence or sample reuse.
- **PROMOTE** only if the same all-three-incumbent overlay configuration has strictly higher Holdout
  net CAGR and Sharpe and strictly smaller MaxDD than B0/F4/O1, with Holdout DSR ≥ 0.95 and nominal
  block p < 0.05, at **all** 2/5/10 bp one-way. Otherwise **DO NOT PROMOTE**. Standalone and pair
  tests are diagnostic, not alternate gates. Promotion would mean prospective Paper research only;
  no outcome grants live authority, activates a policy, or changes a mandate.
