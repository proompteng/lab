# Bayn ETF Noise Area: SHADOW → PAPER activation

**Status: standalone strategy only.** Wave 6D adds `bayn.etf-noise-area-policy.v1` without changing the active v2
policy, controller, migrations, or grants. This runbook is for a separately reviewed activation after
[Wave 4B](https://github.com/proompteng/lab/pull/16371) is deployed and its recovery behavior is verified.

Import the policy, signal evaluator, and order planners directly from
[`policy.ts`](../../services/bayn/src/strategy/etf-noise-area/policy.ts),
[`signals.ts`](../../services/bayn/src/strategy/etf-noise-area/signals.ts), and
[`exit-plan.ts`](../../services/bayn/src/strategy/etf-noise-area/exit-plan.ts), respectively.

## Why QQQ + SMH first

Both ETFs already belong to Bayn's [22-symbol equity source universe](../../services/bayn/src/strategy/intraday-market.ts)
(`torghut-core-equity-v3`), so the default cohort needs no Dorvud, Kafka, or Flink universe expansion. Symbol coverage
does not establish that live IEX observations reproduce SIP signals. The six-ETF preset is for a future validated SIP
lane; do not activate it using the current universe.

In the [Wave 5A blind SIP replay](https://github.com/proompteng/lab/blob/73b26d5ad6875064fe4df4dcdc5bf1a844949112/docs/bayn/evidence/2026-11-27-8yr-unseen-intraday-oos/README.md),
frozen C5 was the only fully resolved variant positive at any tested cost: +$41,849 at 2 bp round trip over 2,012
untouched sessions (bootstrap `p = 0.00850`, +$19,873 excluding the top ten days, seven of eight years positive).
It lost money at 10 bp; modeled blind breakeven was **7.12 bp RT**. The stitched +$67,164 at 2 bp includes previously
inspected sessions. These results qualify the signal hypothesis for prospective evaluation, not the new stop-limit,
capital sizing, or fills: the frozen replay used different sizing, no protective stop for standalone C5, and a 5-minute
execution grid.

## Gate 1: SHADOW after Wave 4B

- Verify the running Wave 4B image and replay the half-day close and cancel/reconcile path. Pin the new commit, policy
  hash, cohort, feed, and official provider calendar in the shadow decision receipts. Leave v2 and execution authority
  unchanged; SHADOW must produce no ETF broker orders.
- Bind the prior 14 official regular sessions and the previous regular close needed to seed ATR14 to immutable
  receipt times. Use finalized opening and checkpoint-ending minutes only. A missing prior checkpoint (including one
  after a prior half-day close) stays `MissingWarmup`; do not fill it from a neighboring minute or another feed.
  A required minute or prior summary timestamped before its minute completion or regular close fails the observation,
  even if a finalized revision is also present. A zero-width band blocks entries but still permits opposite-band exits
  at the open/previous-close anchors.
  Compare captured IEX and same-time SIP decisions and publish missing coverage, data latency, and signal disagreements.
- Verify 10:00–15:00 ET checkpoints on normal days and a 12:30 ET last checkpoint on 13:00 ET early closes.
  Exercise regular-close-minus-two-minute flatten without bars or a warm baseline. On both
  [2026 Black Friday and Christmas Eve](https://www.nyse.com/trade/hours-calendars) the deadline is 12:58 ET, not
  two minutes before the extended data session ends. Verify late receipt, missing minute, duplicate order recovery,
  stop-limit gap-through, and partial-fill cancellation in replay before enabling PAPER.

## Gate 2: PAPER only

- Require signed-off SHADOW evidence and the reviewed [Bayn release and authority path](../../services/bayn/README.md#delivery).
  Bind the exact image, source revision, policy and risk identities to the PAPER account. Reconcile v2 to flat with
  terminal orders, no unresolved mutation, and complete accounting before switching the account's single writer.
  Check fresh broker eligibility (including short/borrow eligibility) and the effective account and strategy risk
  ceilings before any entry; this policy grants no authority.
- Reserve whole-share absolute gross against the lesser of the approved capital budget and **$180k**, including
  existing positions and all pending entries. Do not net long against short. Enforce live marked gross again at
  submission and reconciliation: a sell limit is a minimum price, not a bound on a short's fill notional.
- Verify the **25 bp** entry collar and fill-anchored **1.5× ATR14** trigger. The protective **STOP_LIMIT** uses
  `max(50 bp, 0.25 × ATR14_bps)`, capped at **150 bp**, measured from the stop trigger and rounded inside the collar.
  Require broker confirmation and quantity reconciliation before treating any partial or full fill as protected.
  Do not carry an entry into a later checkpoint. For an opposite-band or timed exit, cancel and reconcile outstanding
  entry/protection orders, then reduce only the actual remainder using Wave 4B's bounded close path. A triggered
  stop-limit is not a guaranteed fill; use that recovery path for unfilled protection. Independently schedule flatten
  from provider `regularCloseAt` and verify flat inventory and terminal orders before regular close.
- **Daily realized-slippage gate: ≤ 2.5 bp RT** across matched PAPER lots, with a cohort total and per-symbol breakdown.
  Record contemporaneous decision and exit reference prices before submission. For each matched lot, sum adverse
  side-signed fill-minus-reference bp on entry and exit; weight round trips by entry reference notional. Report fees,
  partial/unfilled orders, spread, and unresolved exits separately. A no-fill or unreconciled day is not a passing
  measurement. Above 2.5 bp RT, or on a missed flatten or unreconciled exposure, halt new ETF entries, preserve recovery,
  and return to SHADOW after reconciliation for diagnosis. The 7.12 bp blind breakeven is a research comparison, not
  an operational tolerance. PAPER slippage is not evidence of real execution quality or permission to trade live.
