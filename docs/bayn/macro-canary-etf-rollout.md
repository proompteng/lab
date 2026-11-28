# Bayn macro canary ETF rollout

**Status: pure module only.** This change does not register a scheduler, write to a ledger, authorize orders,
modify the active intraday v2 policy, or deploy anything. SHADOW and PAPER require a separate reviewed integration.

## Reference and production differences

The source is [Wave 5D #16376](https://github.com/proompteng/lab/pull/16376), pinned to
[`06e85b0`'s frozen report](https://github.com/proompteng/lab/blob/06e85b0e59f70c8b09181266a883179c8c90b498/docs/bayn/evidence/2026-11-27-etf-canary-macro-v2/README.md).
Only `ensemble/base/21/0.05` passed all strict retrospective split tests at 2, 5 and 10 bp. At 2 bp it turned
2.18×/3.20×/2.62× one-way per year (Train/Validation/Holdout), had 5.91% Validation and 6.31% Holdout drawdown,
and stayed SHY-excess-positive in all three splits for 27/27 single-symbol omissions. Holdout returned +28.33%
(+17.58 pp over SHY; bootstrap p = 0.0478). Range endpoints from other variants are not base-trial metrics.
No trial qualified; the Holdout tape had been seen in prior research and the base trial failed the neighboring
plateau test. Omission results do not authorize production to trade with missing data.

The [policy](../../services/bayn/src/strategy/macro-canary-etf/policy.ts),
[signals](../../services/bayn/src/strategy/macro-canary-etf/signals.ts), and
[rebalance planner](../../services/bayn/src/strategy/macro-canary-etf/rebalance-planner.ts) record all three arms:
breadth-protected 12/4/2/1 canary momentum, continuous volatility-normalized TSMOM, and the 63-session
credit/inflation/dollar state with a five-session EMA of regime portfolios. Equal **risk** budgets yield
variable capital weights through the frozen covariance and solver; neither the standalone trend nor standalone
macro execution rules govern the ensemble. Golden tests match the reference's pre-constraint blend bytes at
synthetic review closes. The compiler emits diagnostics daily and flags review at close indexes `252 + 21k`.
Pin the verified session calendar to the policy's `historyStartSession` (default 2018-06-19, the start of coverage
for XLC in the reference); never slide the start date. The research tape started in 2016 and allowed specific
legacy gaps. Production requires all 27 symbols on every session of its registered window; it does not
recreate the legacy calendar phase or seed state.

Only the long-only book is proposed for first activation. Default gross is at most 100% of sleeve equity;
every ETF, including SHY, is capped at 50%. Explicit macro/canary SHY exposure and the idle SHY sweep share
that limit; unsweepable residue stays in cash. The signed TSMOM variant has a different hash, caps aggregate
short weight in both the trend arm and the final portfolio, and is not part of first activation. The production
planner checks a per-ETF **10 percentage point** band against raw reference marks; Wave 5D used 5 points against
prior-close holdings and separately re-swept idle SHY when trading. Collar limits, integer sizing, turnover and
cash reservations also differ from the research replay. Do not inherit its performance claims for this policy.

## Daily opening workflow (America/New_York)

Use the exchange calendar for holidays and DST. Skip a nonstandard opening rather than reusing regular-session
timestamps. One account writer owns both execution and recovery for the sleeve; never stack an unconfirmed order
on a retry. On non-review days, record the signal and hold, without new orders.

| Time (ET)   | Required action                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 09:20       | Reconcile whole-share positions, open/unknown orders, cash and corporate-action changes. Bind the preceding completed session and the next open to the verified calendar.                                                                                                                                                                                                   |
| 09:20–09:29 | Verify the complete SIP daily OHLCV history with `adjustment=all` and a point-in-time adjustment receipt effective through the prior close. Compile and store the decision, policy hash, input revision, three-arm attribution and review flag. Missing bars, unresolved revisions or stale evidence mean no submission; never forward-fill or substitute.                  |
| 09:30       | Obtain fresh **raw** regular-session reference quotes, legal ticks and reconciled shares in the live split basis. Plan integer-share limits no wider than 15 bp from the raw reference; never size using adjusted history or price a limit with yesterday's adjusted close.                                                                                                 |
| 09:30–09:35 | PAPER only after sign-off: submit regular-session limit orders near the open. This does not assume opening-auction fills. Submit reductions first; wait for terminal reconciliation and refresh quotes, equity, spendable cash and remaining budget before planning increases. An unresolved, stale, out-of-collar or unacknowledged leg does not authorize further orders. |
| 09:35       | Stop new submissions and cancel working remainder. Reconcile fills and cancellations or hand off to the existing account recovery owner; never chase the order or force a same-day retry.                                                                                                                                                                                   |

Reserve two-way notional at the upper collar; count actual filled buys plus sells divided by twice contemporaneous
sleeve equity toward the 6× one-way rolling 252-session budget. The owner must include outstanding reservations,
reconcile any price-improved fills using actual execution values, and pass remaining bps rounded down. Cash must be
settled, unreserved and net of fees; anticipated proceeds, intraday allocations, broker margin buying power and short
collateral are not available cash. A risk limit already breached at conservative marks or a fractional share balance
requires existing recovery authority, not a new strategy order.

## $100k dual-horizon isolation

Before PAPER, register $100k of total test capital, split **$50k macro / $50k intraday** in separate broker
paper accounts with separate ledgers, risk reservations, order identities and reconciled ownership. Both can
trade QQQ; the distinction is account identity, not time of day. The macro sleeve may hold overnight; the
intraday ETF Noise Area sleeve retains its own flatten-before-close and flat-overnight checks. No shared buying
power, netting, broker positions, liquidation, credentials or intraday-v2 policy change is part of this module.
If isolated accounts and the existing account fences cannot be verified, stay in SHADOW.

## Prospective 120-session acceptance

Run SHADOW first; move to isolated PAPER only after reviewing the inputs, account boundaries and dry-run
decisions. Before PAPER starts, register 120 consecutive eligible exchange sessions, the exact policy hash,
calendar, isolated accounts, cost model, drawdown ceiling and SHY comparator. Keep a parallel SHADOW decision
receipt for each PAPER session. Do not discard skipped sessions or restart the clock to hide failures:

- [ ] Every session has a terminal decision or a recorded fail-closed reason. Reproducing each decision from
      archived point-in-time evidence gives the same bytes, including on restart. Report any missing required bar.
- [ ] No orders outside the authorized window or on non-review days, no duplicate/unresolved mutation reused,
      no cross-account QQQ collisions, and intraday is flat overnight on every session.
- [ ] PAPER reconciliation matches raw quotes/ticks, whole shares, collar, no borrow or margin, conservative
      gross/concentration caps and rolling turnover budget. Exercise missing data, split/dividend basis changes,
      partial fills, cancellation and restart in supervised drills. Track missed trades, residual cash and costs.
- [ ] For these same sessions, report PAPER net, SHY excess, Ex-Top-5 and Ex-Top-10 excess, MaxDD, turnover and
      uncertainty, including the 2/5/10 bp round-trip stresses and all recorded fees. Require positive net and
      all three excess tests at each stress, stay within the registered drawdown ceiling and keep one-way turnover
      below 6× annualized. Treat low sample size and
      unresolved economic or operational evidence as no-go; passing this checklist alone grants no live authority.
