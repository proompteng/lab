# Bayn macro ETF core

The macro ETF core is a **pure planning module**, not an active strategy. It is not registered in the Bayn
controller and has no broker, scheduling, risk-grant, or capital authority. The existing intraday v2 strategy,
strategy selection, and migrations are unchanged. See the [dual-horizon replay](evidence/2026-11-27-macro-etf-core-dual-horizon/README.md)
for results and its separate account model.

## Policy and signal

Import the policy, signal, and planner contracts directly:

```ts
import { decodeMacroEtfCorePolicy, Profile } from '../../services/bayn/src/strategy/macro-etf-core/policy'
import { computeMacroEtfCoreSignal } from '../../services/bayn/src/strategy/macro-etf-core/signals'
import { planMacroEtfCoreRebalance } from '../../services/bayn/src/strategy/macro-etf-core/planner'
```

- **Policy:** Supply `{ schema: 'bayn.macro-etf-core-policy.v1', profile: Profile.F2 }` (or `Profile.F4`).
  The strict decoder rejects extra configuration. Its canonical SHA-256 binds the version, 29-symbol order,
  immutable parameters, and selected profile.
- **Evidence:** Supply the `bayn.macro-etf-core-close-snapshot.v1` snapshot, its canonical SHA-256, and the
  observation cutoff `asOf` in UTC epoch milliseconds. The snapshot contains a dataset version,
  `adjustment: 'all'`, an authoritative session calendar starting 2016-01-04, and the aligned OHLC close rows.
  Append exactly one calendar session without bars for the next open. The caller must authenticate the source,
  choose the official calendar, and record when each close became available. The digest binds content; it
  does not authenticate market data or certify that the caller supplied the full official calendar.
- **Admission:** Bar dates must match their session; their availability cannot precede the completed close or
  follow the next open or observation cutoff. A bad row anywhere, including in warmup or on a non-review day,
  invalidates the whole observation. All ETFs except XLC and XLRE are required in every session. XLC (inception)
  and XLRE (historical coverage gaps) enter the offensive basket only after 20 consecutive observations; a
  missing candidate resets that count but does not erase its previously smoothed allocation. A missing execution
  mark for an eligible target or holding still fails the planner.
- **Output:** After 100 closes, review every 42 sessions, anchored to the first full window. The live evaluator
  yields only the immediately preceding session's review or `undefined` on a valid non-review day. Both
  production and offline replay return a typed `MacroEtfCoreEvidenceError` on invalid evidence. Offline replay
  validates the whole supplied path and uses the same causal equations; no partial path is returned.

The exact [Wave 5C protocol](evidence/2026-11-27-10yr-vol-regime-carry/protocol.md) selected F2
(`F2-42-IEF-100-10`) and F4 (`F4-42-1-LQD-parity`). F2 gives two votes to HYG/IEF and one to HYG/LQD
above their seed-mean EMA100; F4 reverses the weights of those votes. The remaining defensive budget goes to
the strongest positive haven above EMA100 that passes the duration, inflation, and dollar gates. Both smooth
the resulting portfolio from zero at alpha 2/11. F4 adds the 50% inverse-RV20 risk-parity sleeve and 25% RV60
risk-parity sleeve compressed by the RV5/RV20 and RV20/RV60 gates. Its residual 25% is the F4 credit/haven
allocation. The signal is a target before carry, not an order or expected return.

## Next-open planning

The planner binds its input to the recomputed policy hash and the scheduled close/open pair. Its price
evidence is for that exact opening event (no later marks), with the preceding close on held positions.
The opening timestamp is the logical pricing watermark for this plan, not a claim that a live system can
observe an opening fill and still execute at that same price. A live adapter would need a separately
reviewed executable pricing and admission contract.

1. Work only on reconciled positions owned by the sleeve. The caller reserves pending and foreign orders
   and accounts for other holdings before supplying residual cash, debit and gross limits. List symbols
   occupied by another sleeve in `protectedSymbols` to suppress buys and sells on them, including on an
   owned position in the same symbol. Any such owned position still counts toward gross and cash constraints.
2. Allocate the difference to SHY and compare prior-close notionals with the target. Unless the larger of
   aggregate buys or sells reaches 10% of prior equity, produce no orders. Opening gaps alone do not cause
   a discretionary rebalance. If an unchanged book is already outside caps, fail closed; the caller's
   risk owner must handle the breach.
3. Use integer USD micros and whole shares. Mark to the opening, limit target sizing by equity and the
   residual gross cap, settle sells before buys in fixed universe order, round costs against the account,
   and reduce buy quantities until they are affordable. Check cash/debit, gross, and margin requirements,
   including broker-supplied marginability. Report blocked symbols and post-plan cash and gross; do not
   assume that the orders executed or treat buying power as cash.

The research account uses the production signals, carry calculation, prior-close deadband and integer cost
arithmetic. Its shared ledger also applies the historic Wave 6C gross and DTBP conventions and coalesces
same-symbol sleeve orders. It is not a replay of the production planner's per-sleeve cash reservations,
and its risk-only trims at open/close are not discretionary off-cadence macro orders.
