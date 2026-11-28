# Bayn intraday v2.1 — PAPER cutover checklist

**Candidate only.** This change does not select v2.1 in the deployed runtime, admit a new mandate, edit migrations
0222/0223, or alter the active v2 parameter hash
`f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509`. The existing 20 symbols,
sleeves, SPY benchmark, feeds, signal rules, sizing rules, stop-trigger and target rules, and account risk policy are
retained. No Dorvud/Flink migration is needed.

## What changes and why

- **Entry:** widen the completed-bar buy ceiling / short-sale floor from 10 to 30 bp. The candidate constructor
  accepts integer 25–35 bp; any override changes the canonical hash. Freeze the default 30 bp candidate:
  `5b3c0205f2ff3ba18bc70197fbc4b715fd8d1f721ea59114232bde95fde527bd` (parameter hash, not a grant).
- **Stop-limit:** use the separate width `min(150, max(50, 0.25 × ATR14_bps))` bp from the existing strictly
  prior daily baseline, applied to the stop trigger. Missing or invalid ATR leaves the leg unfunded. Broker-tick
  rounding adds execution tolerance only within the hard 150 bp cap. A stop can still gap through that cap.
- **Midday:** for an intended 2L+2S basket with incomplete fills at the entry deadline, cancel working entry
  remainders first and obtain terminal broker reconciliation. Recompute signed USD exposure using actual open
  whole shares and contemporaneous marks, then reduce only the heavier side; close all remaining shares if
  one-sided. Never add a hedge or reverse a leg. Retain the exact whole-share rounding residual and reconcile
  resulting fills before treating the trim as effective. Completed baskets and intentional smaller baskets are
  outside this guard. The guard is a pure plan, not a broker executor or an atomic fill guarantee.

The reported November 27 Black Friday GOOGL short (103 shares) had a $275.31 stop and $275.58 buy limit.
The reported $275.88 trade was outside that limit; the 50 bp floor yields a $276.69 buy limit at the **same** trigger,
making that price eligible, not proving an actual fill or avoided loss. [Wave 1E (#16356)](evidence/2026-11-27-execution-microstructure/README.md)
observed 4/17 blocked live-tape stop triggers at 10 bp and 0/17 at the fixed 50 bp buffer. Its 35 bp entry scenario
improved paired 5 bp net by $4,923 at the post-decision clock; changing the clock changed the result.
[Wave 2B (#16359)](evidence/2026-11-27-3yr-sip-bayn21-v2/README.md) found 33.4% versus 82.1–94.5% four-leg
completion and 29 versus 4 blocked stops in its 729-session SIP comparison. Fixed-alpha 25/50 and 35/50 bp
scenarios changed 5 bp net by −$6,193 and +$1,109 respectively. The $13,087 result was a different, unqualified
sleeve/exit design. Neither study scored the exact 30 bp plus adaptive-stop plus residual-trim candidate.

## Compare before cutover

Run each policy against the **same** receipt-verified eight-column ClickHouse/SIP bar exports and provider calendar.
Include strictly prior warmup, and supply verified `--splits` for as-traded inputs only if needed; see
[the existing replay input contract](intraday-alpha-cutover.md#replay-guarantees-and-limitations).

```sh
for policy in v2 v2_1; do
  bun services/bayn/tools/verify-intraday-alpha-replay.ts \
    --calendar "$CALENDAR" --policy "$policy" \
    --evaluation-start "$START" --evaluation-end "$END" \
    "$WARMUP_BARS" "$EVALUATION_BARS" > "$OUTPUT_DIR/$policy.json"
done
```

Compare input and calendar hashes, then filled/selected legs, blocked stop bars, residual before/after trims, unresolved
outcomes, and modeled cost scenarios. The candidate scenario assumes expired orders are terminal and prices reduce-only
trims at the first whole-minute open strictly after expiry, after honoring exits on earlier bars. With L1, exposure
uses the midpoint and trim execution uses the adverse first BBO. A missing required mark makes the result unavailable.
This does not establish historical queue priority, actual fillability, original arrival, broker cancellation or protection
ownership. Both outputs are `UNQUALIFIED`.

## Post-close PAPER promotion (separate reviewed change)

1. **Prerequisites:** Wave 4B must be merged and its native execution/recovery behavior verified on the target PAPER
   account. Keep v2 until a reviewed release binds the candidate throughout native decision compilation, durable
   validation and audit, protection submission, and account-owned residual recovery. Prove with a native PAPER
   fixture that stale marks, late fills, unresolved cancellations and bracket races cannot cause over-closing or a
   new order. This PR supplies the pure candidate and replay; `--policy v2_1` cannot activate it.
2. **After the provider's actual regular close** (13:00 ET on a half-day), run the existing read-only v2 audit:
   `bun services/bayn/tools/audit-intraday-alpha-session.ts --session "$SESSION" --account "$PAPER_ACCOUNT" --regular-close "$CLOSE_ET"`.
   Check the same Alpaca sandbox account in `GET /v1/status`: fresh EXACT reconciliation, zero positions, open
   orders, nonterminal intents and unresolved mutations, complete fill accounting, and no recovery in flight.
   Do not cut over with any open positions or outstanding ownership. Preserve the settled v2 report and exact
   deployed source, image, mandate and strategy/risk identities.
3. **Prepare and release:** bind the candidate parameter and compiled strategy/protocol hashes plus the unchanged
   account-bound v6 risk hash to a newly reviewed same-account PAPER request. Update the sealed request and mandate
   identity together; follow the [native GitOps mandate rotation](../../argocd/applications/bayn/README.md#research-mandate-rotation)
   and [immutable release path](../release-automation.md). If native admission needs a migration, it must be additive,
   not a change to 0222/0223. Verify successful CI, exact image/source, selected Freight and generated `kargo/bayn`
   commit, Argo sync and native activation receipt. Do not call the broker or activate manually.
4. **Read back before the next open:** prove the candidate's exact source/image and strategy/risk identities,
   effective PAPER (sandbox only), clear kill state, natural controller progress, fresh EXACT reconciliation, no
   unresolved orders or mutations and no off-hours equity orders/fills. At the open, verify fresh input and the first
   durable candidate decision or explicit abstention. Verify actual broker terms and recovery receipts on orders that
   naturally occur. Stop new entries on any identity, reconciliation, protection or residual-ownership violation.

## Rollback

If activation did not succeed, revert the complete source binding/request/hash/generation change through reviewed
GitOps. If it succeeded, suspend candidate entry through the native authority path; keep existing position protection
and settlement under the existing recovery owner. Once flat with terminal orders, complete accounting, and fresh exact
reconciliation, use reviewed GitOps to deactivate the native owner and verify clear OBSERVE, zero unresolved mutations,
and no off-hours broker-ledger advance. Restore the v2 binding and approved v2 PAPER mandate together through a new
reviewed release and the same Kargo/Argo path. Confirm the v2 parameter hash above, v2 protocol hash
`5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d`, the same account/risk policy, exact
reconciliation, and natural native progress before resuming. Never revert only the Secret or prune an active writer.

## Daily PAPER KPIs

Record by sleeve, side and liquidity bucket; retain timestamps, policy/image hashes, and denominators. Compare against
the frozen v2 baseline rather than judging by one day's P&L.

| KPI                  | Daily measure                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry slippage       | p50/p95 and notional-weighted signed adverse bp against the completed signal close: `10,000 × sideSign × (fill / close − 1)`, buy +1, sell −1. Report orders submitted, filled shares/intended shares, and no-fill rate.                                                      |
| Protective stops     | Unique activated stops, blocked stops / activated stops, time from trigger to first/final fill, p50/p95 adverse bp versus trigger, largest adverse mark beyond limit, timed fallback and unresolved counts. Verify no fills outside limit or submitted limits beyond the cap. |
| Basket residual      | Fully filled four-leg attempts / submitted four-leg attempts; initial and post-trim signed USD, p95/max absolute residual, time to terminal entry cancellation and to confirmed trim. Keep unavailable marks and one-sided inventories explicit.                              |
| Economics and safety | Realized net after attributable fees, funding/borrow and other known costs, with missing costs identified. Record coverage, failed reconciliation, guard/risk violations and unknown mutations separately; a violation blocks continued PAPER evaluation.                     |
