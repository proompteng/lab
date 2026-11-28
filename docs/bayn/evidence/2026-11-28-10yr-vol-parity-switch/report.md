# Wave 24A: realized-volatility and equity–bond parity switch

**Goal:** Test whether a daily next-open switch earns positive net market-model alpha or improves Calmar and maximum
drawdown when added to the incumbent Bayn sleeves. This is a historical research screen, not trading authority.

## Pre-registered protocol

### Data and walk-forward windows

- The only candidate prices are `SPY, QQQ, TLT, IEF, SHY, GLD` from the adjusted Alpaca SIP daily tape in
  `agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/`. Verify the manifest, all six memberships,
  compressed and decoded tape receipts, and exactly one valid bar per asset per session on the pinned calendars.
  No supplement, forward fills, or proxies for these six assets. The DIA/UUP supplement and the split-adjusted
  intraday tapes are only for the incumbent controls.
- The tape spans 2016-01-04 through 2026-11-25 (2,741 sessions). Use 2016–2019 as the initial history and
  descriptive development window. Advance once through three disjoint OOS windows: 2020-01-02–2021-12-31 (505
  sessions), 2022-01-03–2023-12-29 (501), and 2024-01-02–2026-11-25 (729). Carry state and trailing history forward;
  use only information before each execution and never fit on the score window. There is no grid search, refit, or
  alternate candidate. Results from all 1,735 OOS sessions in sequence form the primary comparison.
- Replay controls from the first tape date, check the published B0/F4/O1 fold totals, and compare every path on the
  identical 2,719 sessions (from the first eligible open, 2016-02-04). The full window includes development; the
  latest OOS window is a stability check, not blind to the wider historical Bayn research program.

### Signal, portfolio and frictions

1. At session close use the latest 21 simple adjusted close-to-close returns, including that close. Realized
   volatility is sample standard deviation times √252. Initialize calm; enter stress at SPY volatility **≥20%**,
   return to calm at **≤15%**, and retain the previous regime in between. Stay in cash until 21 returns exist.
2. Compute the same volatility for the equal-weight SPY/QQQ and TLT/IEF daily return baskets. Divide the parity
   sleeve between the two baskets in inverse proportion to their volatilities, with equal weights within each
   basket. Calm allocates 90% to parity, 5% to SHY and 5% to GLD; stress allocates 40%, 45% and 15% respectively.
   Run an always-calm parity comparator with the same timing and costs to isolate the value of switching.
3. Use closing marks and current positions to decide whether the larger of buy or sell notional implied by the
   target is at least 2% of NAV. If it is, execute at the **next** recorded open, not the signal close. Old positions
   earn the overnight move; new positions earn the open-to-close move. Close-to-close portfolio returns are dated
   by the ending session. No leverage, short positions, interest on warm-up cash or terminal liquidation.
4. Stress **0 / 2 / 5 / 10 bp round-trip** slippage, half on each actual buy and sell dollar, plus 0.21 bp on sales
   in every case. Both buys and sells are funded out of the portfolio after fees. Use the existing B0 (QQQ/SMH
   intraday, native fixed-$100k P&L divided by $100k), F4 (`F4-42-1-LQD-parity`, SHY-idle) and O1
   (`ensemble/base/21/0.05`, SHY-idle) replays at matching slippage; SPY is frictionless total return.

### Measurements and decision

- Compound daily net returns; annualize CAGR by 252/session count, Sharpe by √252, and one-way turnover by 252.
  MaxDD is positive peak-to-trough loss from a starting NAV of 1; Calmar is CAGR / MaxDD. Net alpha is the ex-post
  OLS intercept of switch-minus-SHY against SPY-minus-SHY, annualized arithmetically by 252. SHY is a traded
  short-duration comparator, not a pure risk-free rate; this single market factor does not control for duration,
  gold or other exposures. The regression never feeds a trading decision.
- Measure Pearson correlation against SPY, B0, F4, O1, and the equal B0/F4/O1 basket. Compare each with a fixed
  25% allocation to the switch, reducing the incumbent weights pro rata. Reset sleeve weights every session,
  charging half the round-trip cost on gross transfers. These are separately funded return-path diagnostics, not
  simulated joint fills, intraday netting, or evidence that overlapping instruments or exposures cancel.
- For pooled OOS, use paired [stationary bootstrap](https://doi.org/10.1080/01621459.1994.10476870) with 5,000
  circular resamples, mean block 10 sessions, seed `0x24a2026`, and 2.5th/97.5th percentile intervals. Resample the
  actual matched session paths together; refit alpha and recompute compound-path Calmar/MaxDD on each draw. The
  intervals are conditional on this historical path and block choice and do not correct for prior Bayn studies.
- **PROMOTE** only if the *same* route passes at all of 2, 5, and 10 bp:
  - **Alpha:** pooled OOS net CAGR and alpha lower bound are positive, and alpha is positive in every OOS window.
  - **Diversification:** for the equal B0/F4/O1 basket with a 25% switch allocation, both paired lower bounds are
    positive (blend minus incumbent Calmar, incumbent minus blend MaxDD); both point improvements hold in the
    latest OOS window; pooled annual CAGR drag is at most 1 percentage point; and pooled absolute correlation
    between the switch and the incumbent basket is at most 0.50.
- Undefined required evidence cannot pass. Otherwise the verdict is **DO NOT PROMOTE**. The always-calm comparator,
  individual blends, full-window measurements, and 0 bp scenario cannot substitute for the gate. Even a pass would
  only justify separate prospective evaluation.
