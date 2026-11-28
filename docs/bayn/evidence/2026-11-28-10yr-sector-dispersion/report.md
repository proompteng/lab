# Bayn Wave 21H: sector dispersion and relative-strength rotation

## Pre-registered protocol

**Question.** Does a daily long-only sector rotation earn positive net, SPY-risk-adjusted alpha or
improve the existing Bayn portfolio after trading costs? The 10-year scoring window is retrospective:
time separation protects the rule from lookahead, not from prior Bayn research on the same archive.

**Inputs.** Use only the split- and dividend-adjusted Alpaca SIP daily bars from
`agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/` for the candidate. Verify the
manifest, its ETF roster and the archive byte receipts. Rank the 11 GICS ETFs (`XLK`, `XLF`, `XLE`,
`XLV`, `XLI`, `XLY`, `XLP`, `XLU`, `XLB`, `XLC`, `XLRE`) plus `SMH`. `SPY` is the market reference,
`QQQ` is a growth benchmark only, and `SHY` is the defensive allocation and rate proxy. Use real
bars only. An ETF must have 64 consecutive completed closes to be eligible; no proxy for XLC before
inception and no filling of XLRE's gaps. Unavailable benchmark or held/ordered marks, inadequate
breadth, or a failed archive/control check reject the run rather than drop a session.

**Signal and walk-forward.** At close \(t\), rank by 63-session log return minus SPY's log return,
breaking ties by ticker. For each eligible name compute annualized sample volatility of its last 21
daily log returns minus SPY's corresponding log returns. Dispersion is the cross-sectional sample
standard deviation of those volatilities; require at least 10 eligible names. At or above the
dispersion threshold, target the top three with equal weights; otherwise target 100% SHY. Run one
ungated top-three ablation with identical eligibility, fills, and costs. It cannot replace the
candidate or trigger promotion.

Use the tape from 2016-01-04 for initialization only. Score the ten years from the 2016-11-25 close
through the 2026-11-25 close (first eligible order 2016-11-28). At the start of each calendar-year
fold, including the partial first fold, set the threshold to the interpolated 60th percentile of
the 126 session dispersion readings ending at the prior close, and keep it fixed for that fold.
Carry holdings across fold boundaries. Report all out-of-sample (OOS) sessions, the 2022–2023
validation window and the 2024–2026 terminal holdout separately. No rule or variant is selected
by returns in any fold.

**Execution and costs.** Decide whether to rebalance from the prior-close weights. Do not trade if
the larger of desired buys or sells is at most 10% of equity. Apply accepted targets at the next
session open with fractional shares and a fully funded book. Charge half the round-trip rate on
the absolute dollar value of each buy and sell, funding costs from the book. The four fixed stress
rates are 0, 2, 5, and 10 bp round trip; no other sleeve fee is assumed. Returns are booked
close-to-close: overnight gaps accrue to old shares, next-open fills and costs occur before the
open-to-close mark. Start in cash, pay for initial entry, and mark terminal holdings without a
forced exit. Historical opening bars do not establish executable auction prices or capacity.

**Controls and blends.** Compare adjusted SPY and QQQ buy-and-hold and SHY, plus the exact historical
SHY-idle `F4-42-1-LQD-parity`, `ensemble/base/21/0.05` (O1), and Wave 9B B0 replays. F4/O1 need their
original DIA/UUP supplement and B0 its original SIP intraday tapes; these are used only to reproduce
the controls, never to trade or form the rotation signal. Keep the controls' native fees and verify
their published split totals before scoring. Pair by the same close-booking dates. Compare 25%
rotation + 75% control with each of SPY, F4, O1, and B0 alone, and with the equal F4+O1+B0 stack.
For multicomponent portfolios, reset capital weights daily and charge the same per-side rate on
gross transfers. These are separately funded sleeve blends, not shared-account netting or an
assumption of zero correlation.

**Inference and decision.** Compound daily net returns; annualize Sharpe (zero hurdle), growth
and one-way turnover at 252 sessions; Calmar uses CAGR divided by positive peak-to-trough max
drawdown. Report same-session Pearson correlations. Estimate annualized market alpha as 252 times
the OLS intercept of rotation minus SHY on SPY minus SHY. Use paired circular stationary blocks
(10,000 draws, mean block 10 sessions, seed `0x21a2026`) and percentile 95% intervals for alpha
and the change in portfolio Sharpe. Refit beta and recalculate both Sharpes with the same drawn
indices. These intervals do not adjust for earlier Bayn studies; control blends other than the
stack are descriptive.

Only 5 bp (primary) and 10 bp (stress) govern the verdict. Require positive net return at both
costs on both the complete OOS path and terminal holdout and at least one of these two routes to
pass on **all four** cost/window pairs:

1. **Alpha:** lower 95% bound of annualized SPY/SHY-adjusted alpha strictly above zero.
2. **Portfolio:** lower 95% bound of paired Sharpe lift versus F4+O1+B0 strictly above zero, higher
   point Calmar, and lower point max drawdown.

Undefined required statistics fail the gate. A `PROMOTE` result could only warrant a new
prospective study; neither verdict changes runtime policy, accounts, or trading authority.
