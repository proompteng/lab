# Coordinated F4 and O1 v2

**Opt-in planning only. Historical profitability is not yet verified.** The current F4 and O1 Paper runner,
frozen policies, and B0 are unchanged. This proposal controls #2 and #3 together; it does not target volatility
for the three-account portfolio or authorize submissions, margin, or capital changes.

## How the targets work

- **F4** keeps its registered directional signal and 42-session cadence. The sizing layer reevaluates both books
  at each completed close. F4 still uses its 10% aggregate prior-close drift band.
- **O1** weights positive 21/63/126-session trends versus SHY within independent asset groups. SPY, QQQ and IWM
  share only 15% of the unscaled allocation; duration, real assets, USD and credit have separate budgets.
  Weakening HYG/IEF or GLD outperforming a falling SPY closes equity and credit exposure. A falling TLT trend
  relative to both SHY and IEF closes duration exposure and shifts the budget toward real assets and USD if
  their own trends are positive. O1 reviews every ten sessions or on a change in the stress indicators. Its
  five-percentage-point per-ETF drift band suppresses small changes but never suppresses a zero-target exit.
  The [time-series momentum paper](https://pages.stern.nyu.edu/~lpederse/papers/TimeSeriesMomentum.pdf) motivates
  the diversified trend inputs; its futures results do not establish this ETF policy's returns.
- **Portfolio sizing** projects the current unscaled baskets onto the same 63 completed daily ETF returns. The
  annualized EWMA at decay 0.94 includes the cross term, so common exposure counts even if it is in a different
  account. Use the two accounts' current equity fractions, not the opening capital split. The 8%–12% requested
  volatility is a forecast target; caps, small whole lots, funding and drift can leave realized volatility
  below or above it. The forecast uses the zero-conditional-mean form of
  [RiskMetrics EWMA](https://faculty.runi.ac.il/kobi/riskmgt/rmtd.pdf).
- **Drawdown** uses combined net equity and a persisted, flow-adjusted high-water mark. At a 5% loss, halve both
  capped targets and allow reductions only; at 10%, target cash. These instructions bypass drift bands at the
  next open. The halt does not reset the high-water mark. A gap, missing mark, blocked position, or failed sell
  can defeat the intended reduction. The 12% MaxDD limit is an evidence gate, not a guarantee.

## Planner boundary

Call [`compileMacroPortfolioV2`](../../services/bayn/src/strategy/macro-portfolio/targets.ts) with a common
`{ mode: MacroRiskMode.Cash, targetVolatility: 0.10 }`, the verified adjusted close snapshot, and the two
reconciled prior-close equities plus their high-water mark. Both equities must be in the same units and session,
for isolated sleeve-owned books; the caller must preserve the peak across restarts and handle capital flows.
The O1 phase and covariance need at least 127 completed closes. Required missing or late bars reject the
observation. Optional F4 ETFs cannot get v2 weight without a complete covariance window.

The outputs bind to separate `bayn.macro-etf-core-policy.v2` (F4) and `bayn.macro-canary-etf-policy.v2`
hashes and each sleeve's prior-close equity. Route them only to their corresponding v2 next-open planners and
reconcile each book independently.
Supply exact opening and prior-close reference marks, reconciled whole shares, settled and unreserved cash, and
residual gross and debit limits. The cash mode cannot borrow or use sale proceeds that are not settled. Margin is
an explicit different policy hash; it requires broker-approved residual debit and asset marginability, and cannot
exceed 1.5× post-fee sleeve equity. The cash cap is 1.0×. Neither mode sweeps residual exposure back into SHY after
sizing. A plan assumes the listed reductions for its projected gross; it is not a fill or authority to send
increases before fresh reconciliation. The existing v1 Paper order and recovery path does not consume these plans.

## Historical walk-forward replay

Run the compact report from the repository root with the existing read-only archive binding:

```sh
bun services/bayn/tools/research-macro-portfolio-v2.ts
```

The same command accepts `--archive-directory <mirror>` with no credentials. Mirror the original object keys
under that directory: the two daily manifests and gzip tapes identified in the
[frozen archive receipts](../../services/bayn/tools/pure-etf-dual-horizon-data.ts), plus
`bayn-research-datasets/2026-11-27-sip-8yr-5m-unseen-v2/calendar_2016_2023.json` and
`bayn-research-datasets/2026-11-27/calendar_2024_2026.json`. The reader verifies the original digests and calendars.
No intraday tape, broker access, or results file is needed.

The baseline uses the unchanged Wave 17-9 F4 and O1 target receipts and whole-share model, not the live O1
collar planner. All paths start on 2016-01-04 at $35k F4 and $25k O1 in SHY; no reallocation or transfer is
modeled. The matched measurement period is **2016-11-01 through 2026-11-25**, over ten calendar years. Warmup and
initial holdings carry into it; the baseline O1 remains in SHY until its first eligible review. Each next-open
decision uses fixed parameters and only the past close prefix, including the closing P&L that updates the brake.
This is causal walk-forward on a previously used historical tape, not independently held-out or prospectively
registered evidence. No parameters are fitted or selected from the scored period.

The simulation pays 2/5/10 bp per side and 0.21 bp on post-slippage sale proceeds. V2 models next-session
settlement throughout; margin is charged an assumed 600 bp annual debit rate on an actual/365 basis. Adjusted
OHLC prices stand in for opening/closing marks and adjusted-share lots. The model does not prove historical
point-in-time availability, auction fills, eligibility, house margin, taxes, or operating costs. It reports exact
CAGR, annualized volatility, zero-hurdle Sharpe and Sortino, close-to-close MaxDD, annualized one-way turnover
(two-way notional divided by twice preceding equity, times 252), and Pearson correlation of #2 and #3 net daily
returns. Each cost/mode must improve CAGR and Sharpe, reduce correlation, keep MaxDD below 12%, and obey its
opening gross cap. A failed gate reports the measured rows and returns a nonzero exit; it does not qualify either
policy for Paper or live use.

**Evidence status:** The frozen replay is blocked in the generic runner:
`ConfigError: SchemaError(Expected string at ["AWS_ACCESS_KEY_ID"])`. The archive gives HTTP 403 without
credentials. The deterministic tests cover causal sizing, fee/settlement paths, caps, gaps, and all three cost
tiers, but their synthetic results do not establish profitability. Run with the existing read-only archive
binding or the six verified objects above before making any claim about the economic or drawdown gates.
