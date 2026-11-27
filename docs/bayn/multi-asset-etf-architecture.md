# Bayn multi-asset ETF: Next-Open integration

**Status: pure compiler and planner only.** This change does not select a strategy in Bayn, schedule a job, grant
broker access, add an execution route, or change intraday v2 or migrations. The operational steps and promotion
gates below are requirements for a future, separately authorized implementation.

## Decision contract

At the next exchange session's open (T), trade a portfolio computed from completed sessions through T−1.
The owning modules ([policy.ts](../../services/bayn/src/strategy/multi-asset-etf/policy.ts), [signals.ts](../../services/bayn/src/strategy/multi-asset-etf/signals.ts), and [rebalance-planner.ts](../../services/bayn/src/strategy/multi-asset-etf/rebalance-planner.ts)) take a strict, canonical SHA-256 policy
(`bayn.multi-asset-etf-policy.v1`) and verified inputs. The policy pins the exact universe, the first calendar
session used for the five-session refresh and Wilder RSI warm-up, and the strategy and risk parameters.
The signal records raw sleeve weights, effective contributions after netting and caps, exclusions, the two session
dates, and the policy hash. The planner consumes that signal and reconciled whole-share positions. Its output is a
conditional sequence, not a broker payload or authorization.

| Sleeve                | Rule at T−1 close                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed trend          | Every fifth close, sign of 120-session momentum, inverse 20-return sample volatility, scaled to 10% annualized covariance-aware portfolio volatility. Keep same-sign changes smaller than 5 weight points; cap sleeve gross at 1.8×.          |
| Credit-gated rotation | Every fifth close, use HYG versus SMA50 to select sectors/QQQ or GLD/TLT/SHY. Rank positive 120-session momentum divided by 20-return sample volatility. Allocate one-third to each of up to three names, leaving unused slots in cash.       |
| Pension month-end     | At session −5 close (last session is 0), compare SPY and TLT total returns since the previous month's final close. If their absolute spread is at least 2%, buy the laggard at the next open and exit at the new month's first open.          |
| Turn of month         | Enter at the −2 open (using the −3 close), hold through session +4 (first session is +1), and exit at +5 open. SPY/QQQ inverse-volatility weights target 15% annualized portfolio volatility.                                                 |
| Uptrend pullback      | Buy above SMA100 when Wilder RSI(2) is strictly below 15. Up to four names, lowest RSI first; each entry is min(25%, 5% ÷ annualized trailing volatility). Exit on RSI strictly above 70 or after seven sessions, with no same-close reentry. |

The [pinned Wave 3C evidence](https://github.com/proompteng/lab/blob/6662581cdd7d445ddced6440e72d28c810bb38a1/docs/bayn/evidence/2026-11-27-10yr-multi-asset-risk-premia/README.md)
is a **no-promotion** result. The ensemble's 10 bp Holdout bootstrap p-value was 0.1381; its 20 bp Holdout Ex-Top-5
was −$349; annualized one-way turnover exceeded 12× in two partitions. The golden test checks the five standalone
equations, not research P&L or equivalence of the deployed portfolio. Wave 4A's requested universe has DIA/UUP
instead of SMH/VNQ; there are no substitutes for the removed names and neither added name receives a new signal.
Wave 4A also uses fixed policy capital weights (20% each by default), not the research ensemble's dynamic paper-vol
budgets. Its caps, deadband, whole-share planning, and actual execution model require new evaluation.

## Inputs, recovery, and the opening cycle

- **Calendar and cutoff.** Fetch and validate the official exchange schedule via the broker calendar, including
  complete months at both ends, close times on half-days, the requested execution session, and intervening holidays.
  Compare venue exceptions against the [NYSE trading calendar](https://www.nyse.com/publicdocs/nyse/ICE_NYSE_2026_Yearly_Trading_Calendar.pdf).
  Never infer sessions from ETF bars or weekdays. Freeze calendar identity, the history start, and completed-bar
  versions at the T−1 regular-close cutoff. The price cutoff is independent of the future session schedule.
- **Adjustment and share basis.** Use SIP daily OHLCV with [`adjustment=all`](https://docs.alpaca.markets/us/reference/stockbars)
  for signals. Retain raw bytes, dataset/capture hashes, and action-effective and first-known timestamps. Alpaca's
  symbol `asof` is not an adjustment-vintage guarantee. Use a captured adjustment vintage or reconstruct it from
  point-in-time actions effective through T−1; do not requery a mutable back-adjusted series to replay a decision.
  A gap is not zero return or a stale carry-forward price. A candidate gap excludes its order leg; a missing required
  gate or pension input halts the decision. Malformed bars or an unverified vintage halt the cycle.
- **Order pricing.** Sizing, turnover, and collar anchors use raw prior close in the current share basis for
  pre-open submissions, or observed raw open for an independently qualified early-session path. Never pass the
  adjusted signal price to the planner. After a split or distribution, verify the action, reconciled broker quantities,
  and reference basis before using a prior close. If not comparable in today's shares or distorted by the action,
  withhold the pre-open leg rather than fabricating a raw price, rebasing an outstanding order, or chasing a gap.
  Fractional, unsettled, or unassigned positions require separate reconciliation rather than rounding positions away.
- **09:20–09:27:30 ET:** An exchange-session schedule requests a cycle keyed by account, strategy, and session.
  Build and hash evidence outside the lock. Under the existing account writer in
  [the execution controller](../../services/bayn/src/restate/restate-execution-controller.ts), reconcile position
  ownership, pending orders, and unknown mutations; check grant, risk budget, and broker permissions; then reserve
  cash/exposure and persist order intent identities before submitting. Keep v2 recovery/exits ahead of ETF work.
  Missed deadlines, unresolved orders, and stale reservations skip the opening batch; never send late or open a
  second account writer. A lease expiring is not evidence of cancellation.
- **Opening auction:** When the account, instrument, broker, and venue support it, submit only bounded limit-on-open
  orders before the internal deadline. [Alpaca's OPG cutoff is 09:28 ET](https://docs.alpaca.markets/us/reference/postorder);
  a primary-venue opening auction need not print at 09:30. A simultaneous OPG batch may contain only independently
  safe legs: reserve the full cost of all possible buys and new shorts, count potential sells/shorts without credit
  for pending hedges, and allow at most one order per symbol. Do not assume any earlier plan leg fills, sale proceeds
  fund buys, or a sell closes a long before opening a short. Defer dependent legs rather than assuming a fill.
- **09:30–09:35 ET:** Reconcile auctions, partial fills, rejects, cancels, exact balances, and reservations. Keep
  disputed outcomes fenced until lookup settles them. Do not automatically chase a delayed opening/rejected order.
  Any future early-session limit path must have a separate pre-registered timing/cost gate and replan from fresh raw
  prices and actual fills. Refresh borrow, whole-share constraints, and tighter broker buying-power requirements
  before order submission. The planner neither substitutes for broker margin rules nor proves available borrow.
- **Isolation and rollback.** Start PAPER and any initial LIVE canary on separately authorized accounts with separate
  capital grants and account keys. If sharing is later required, the same account writer must use durable
  strategy-owned positions and aggregate both strategies' gross, short exposure, cash, unresolved orders, and
  reservations under one fence. The ETF strategy may spend only its assigned residual buying power after v2 and
  existing commitments. Ownership of overlapping symbols such as QQQ must be explicit; until v2's management
  can distinguish the lots, do not admit conflicting positions. Do not key the execution lock by strategy.
  On a breach or unknown mutation, disable ETF entries, retain the recovery owner and reservation, and reconcile or
  unwind under existing risk-reducing authority; do not flatten v2 or change its policy.

## Promotion gates (all required)

Register thresholds, policy/image and data identities, account and caps, attribution, stop conditions, and the
unseen evaluation window before opening results. Reject future-data leakage, survivorship substitutions, and tuning
on the Wave 3C Holdout. No mode advances automatically.

| Transition                 | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research → SHADOW          | Reviewed compiler and plan; parity and deterministic replay verified; validated official calendar and adjustment vintage; read-only inputs and no mutation credentials. Register the exact policy and a new prospective sample.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SHADOW → PAPER             | At least 60 consecutive exchange sessions in SHADOW, including two month-end windows. Every session has a replayable immutable decision or an explicit abstention. Zero noncausal inputs, unexplained reconciliation differences, or late/duplicate mutations. Verify action, half-day, no-borrow, partial-fill, and unknown-outcome paths by live evidence or fault injection. Separately authorize the PAPER account and caps.                                                                                                                                                                                                                                                                               |
| PAPER → LIVE canary        | At least 60 PAPER sessions and 40 executable order legs with complete timestamps and official opening references. Zero open reconciliation discrepancies or risk/authority breaches. Use an unseen prospective holdout of at least 126 sessions for net and Ex-Top-5 > 0 at both 10 and 20 bp all-in round-trip stress, one-sided block-bootstrap p < 0.05 at 10 bp, annualized one-way turnover ≤ 12× and maximum drawdown ≤ 10%. The observed delay-to-auction distribution must have notional-weighted median ≤ 5 bp and p95 ≤ 10 bp adverse one-way. No missing prices or borrow costs counted as favorable results. Require a separately reviewed, exact LIVE canary grant before sending any real order. |
| LIVE canary → broader LIVE | At least 40 real, reconciled opening order legs across at least two month-end windows. Realized net slippage must meet the same median/p95 bounds against the frozen decision reference; report fill vs. the official opening print as a separate measure. Zero unauthorized orders, unresolved mutations, or attributed position discrepancies. Any larger capital ceiling requires a new grant and review.                                                                                                                                                                                                                                                                                                   |

Record the decision midpoint/raw reference, time and source, primary-venue opening auction print, first executable
NBBO, routed limit, acknowledgements, fills, canceled/unfilled quantities, fees, and observed borrow/funding.
For buys use `(execution − reference) / reference × 10,000`; reverse the sign for sells. Report decision-to-auction
on **all** executable intents (including unfilled), plus fill-to-auction and total fill slippage, fill ratio and
missed opportunity separately. Do not treat a SIP daily open or paper fill as a real auction fill.

Keep the base P&L ledger at zero yield on uninvested cash. An opt-in SGOV/SHY overlay may use only unencumbered
capital after **gross** exposures/reservations, not short proceeds or assumed fills. Record deliberate SHY rotation
separately from sweep share-days even if broker fills net to a single SHY trade. Attribute the sweep's actual
distributions, price P&L, costs, and slippage separately from sleeve alpha; do not add distributions a second time
to adjusted-return marks. Report the matching zero-yield counterfactual and broker cash interest separately.
Sweep P&L cannot rescue a failing promotion gate.
