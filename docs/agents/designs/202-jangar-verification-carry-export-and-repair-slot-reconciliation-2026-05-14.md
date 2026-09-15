# 202. Jangar Verification Carry Export And Repair Slot Reconciliation (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar verify-trust foreclosure export, Torghut no-delta auction carry, repair-slot reconciliation, rollout,
rollback, validation, and zero-notional capital safety.

Companion Torghut contract:

- `docs/torghut/design-system/v6/208-torghut-jangar-verification-carry-bridge-and-no-delta-reentry-market-2026-05-14.md`

Extends:

- `201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
- `194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`
- `docs/torghut/design-system/v6/206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
- `docs/torghut/design-system/v6/199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md`

## Decision

I am selecting a **compact verification-carry export plus repair-slot reconciliation packet** for Jangar.

Jangar already has the facts that Torghut needs. On 2026-05-14 around 16:11Z, the control-plane status route reported
`execution_trust=degraded`, source rollout status `block`, a verify-trust foreclosure board in `observe` mode, and
open tickets for execution trust, stage trust, plan trust, verify trust, source rollout split, controller witness,
route stability, Torghut repair-only state, and revenue-repair settlement custody. It also denied the
`torghut_no_delta_active` ticket, which is correct because Torghut's no-delta budget was already consumed.

The problem is transport and reconciliation, not vocabulary. Torghut's live `/trading/revenue-repair` surface showed
`reentry_decision=deny`, `selected_ticket=null`, and reason `jangar_verification_carry_unavailable`. Jangar's
`repair_slot_escrow` also blocked because the selected receipt source revenue-repair ref mismatched and a material
reentry receipt was missing for the selected executable alpha. Those are useful reason codes, but today they are
visible only after a human compares Jangar status with Torghut revenue repair.

The selected design adds `jangar.verify-trust-foreclosure-carry.v1`, a compact Jangar packet exported for Torghut's
auction. It also refines repair-slot reconciliation so source-ref mismatch and missing material-reentry receipt become
machine-readable release-condition inputs instead of generic slot blockers.

The tradeoff is that Jangar has to curate a smaller contract instead of exposing its whole board. I accept that. A full
board export would be faster, but it would make Torghut depend on Jangar's internal control-plane schema and would
turn every future Jangar field change into a trading-surface compatibility risk.

## Governing Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Jangar value-gate mapping:

- `failed_agentrun_rate`: duplicate no-delta and stale carry packets deny new material launch slots.
- `pr_to_rollout_latency`: deployers get one carry id and one repair-slot reconciliation packet instead of manually
  gathering source, image, board, and Torghut evidence.
- `ready_status_truth`: `/ready=ok` remains serving truth; the carry packet is material evidence, not serving health.
- `manual_intervention_count`: source-ref mismatch and missing material-reentry receipts become explicit next actions.
- `handoff_evidence_quality`: engineer and deployer handoffs cite carry id, selected ticket, active release key,
  validation command, and rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: carry export is only relevant to the alpha-readiness queue item and its prerequisites.
- `zero_notional_or_stale_evidence_rate`: stale carry is denial evidence.
- `fill_tca_or_slippage_quality`: execution proof may be selected only if the carry names it as the release
  prerequisite.
- `post_cost_daily_net_pnl`: carry cannot promote capital without current post-cost evidence.
- `capital_gate_safety`: every Jangar carry packet used by Torghut must carry `max_notional=0`.

## Current Evidence

All evidence below was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records,
AgentRuns, GitOps resources, broker state, market data, or trading flags.

### Cluster And Control Plane

- Service-account identity was `system:serviceaccount:agents:agents-sa`.
- Jangar deployment was available with `jangar=1/1`; Agents deployments were available with `agents=1/1` and
  `agents-controllers=2/2`.
- Argo reported `jangar=Synced/Healthy`; `agents` was `OutOfSync/Healthy` during rollout at revision
  `2de0a9e7592b1aaedc8649035b83eb0a7e7e7720`.
- Recent Jangar events showed a fresh rollout to `jangar-798f789cdd`, transient readiness probe refusal while the pod
  started, and then the pod running with both containers ready.
- Recent Agents events showed scheduled discover and verify jobs completing, current implement/verify jobs running,
  and one readiness timeout on the `agents` pod.

### Jangar Runtime Evidence

- `GET /ready` returned `status=ok` and `business_state=repair_only`.
- `GET /api/agents/control-plane/status?namespace=agents` generated at `2026-05-14T16:11:25.232Z`.
- `execution_trust.status=degraded`.
- Source rollout status was `block`.
- The verify-trust foreclosure board was in `observe` mode.
- The board reported `execution_trust_status=degraded` and source rollout truth state `converged`.
- Debt classes included `execution_trust_degraded`, `stage_trust_degraded`, `plan_trust_degraded`,
  `verify_trust_degraded`, `source_rollout_truth_split`, `controller_witness_stale`, `route_stability_hold`,
  `torghut_business_repair_only`, `torghut_no_delta_active`, and `revenue_repair_settlement_custody_deny`.
- Foreclosure tickets were open for all of those debt classes except `torghut_no_delta_active`, which was denied.
- Material gate digest allowed `serve_readonly` and `torghut_observe`, denied `dispatch_repair`, held normal dispatch,
  deploy widening, merge readiness, and paper canary, and blocked live capital actions.
- `dispatch_repair` was denied by `alpha_closure_no_delta_budget_consumed` and
  `alpha_closure_no_delta_debt_active`.
- Repair-slot escrow had `status=block`, no selected slot, and reason codes
  `selected_receipt_source_revenue_repair_ref_mismatch` and
  `material_reentry_receipt_missing_for_selected_executable_alpha`.

### Torghut Business Evidence

- `GET /trading/health` returned HTTP `503` with `status=degraded` because live submission is disabled and the proof
  floor is repair-only.
- `GET /trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, top queue item
  `repair_alpha_readiness`, and value gate `routeable_candidate_count`.
- Repair-bid settlement had `routeable_candidate_count=0`, `41` raw repair bids, and `3` dispatchable lots.
- Alpha closure settlement market was `pending_no_delta`.
- No-delta budget was `consumed` with zero remaining attempts.
- Torghut no-delta reentry auction denied reentry with reason `jangar_verification_carry_unavailable`.
- `GET /db-check` returned `ok=true`, `schema_current=true`, `account_scope_ready=true`, and
  `schema_graph_lineage_ready=true`.

### Source And Test Surface

- Jangar's high-risk shared type surface is `services/jangar/src/server/control-plane-status-types.ts`.
- The verify board reducer lives in `services/jangar/src/server/control-plane-verify-trust-foreclosure.ts`.
- The repair-slot reducer lives in `services/jangar/src/server/control-plane-repair-slot-escrow.ts`.
- `/ready` and `/api/agents/control-plane/status` already emit the verify board and repair-slot escrow, but not a
  compact carry packet dedicated to Torghut.
- Existing tests cover verify-trust foreclosure, material gate digest, Torghut consumer evidence, repair slot escrow,
  and ready route projection. Missing coverage is the compact carry export and the repair-slot reconciliation mapping
  to Torghut auction release conditions.

## Problem

Jangar can see the right debt, but it does not yet publish the right contract.

The concrete failure modes are:

1. Torghut reports `jangar_verification_carry_unavailable` even while Jangar has an active verify-trust foreclosure
   board.
2. Jangar exposes a large board with many tickets, but Torghut only needs one selected carry witness.
3. Repair-slot escrow blocks on source-ref mismatch and missing material reentry without turning those blockers into a
   stable Torghut release-condition input.
4. `/ready=ok` can be misread as material readiness when the material gate correctly denies `dispatch_repair`.
5. A full-board export would couple Torghut to Jangar internals and make rollout compatibility brittle.
6. A self-dispatching Jangar slot would bypass `/trading/revenue-repair`, the business evidence authority.

The next design has to export a narrow, stable Jangar witness that Torghut can safely use.

## Alternatives Considered

### Option A: Export The Full Verify-Trust Foreclosure Board

Jangar would document the whole existing board as Torghut's input.

Advantages:

- Minimal implementation effort.
- No additional reducer.
- Torghut can inspect every ticket and debt class.

Disadvantages:

- The board is an operator/debug object, not a trading contract.
- It would carry more data than Torghut needs.
- It would make Torghut sensitive to Jangar schema churn.
- It would not reconcile repair-slot source-ref mismatches.

Decision: reject.

### Option B: Let Repair Slot Escrow Drive Launches Without Torghut Carry

Jangar would keep the auction local and use repair-slot escrow to decide whether a zero-notional dispatch repair can
launch.

Advantages:

- Keeps launch custody inside Jangar.
- Avoids a new Torghut importer.
- Can reuse current repair-slot escrow logic.

Disadvantages:

- Bypasses Torghut's top revenue-repair queue.
- Can spend a repair slot that Torghut still denies as duplicate no-delta.
- Does not reduce the `jangar_verification_carry_unavailable` blocker.
- Splits business metric ownership between two surfaces.

Decision: reject.

### Option C: Compact Verification Carry Export With Repair-Slot Reconciliation

Jangar builds a small export object from the verify board, material gate digest, repair-slot escrow, and Torghut
consumer evidence. Torghut consumes that object as `jangar_verification_carry`.

Advantages:

- Clears the exact missing witness Torghut names today.
- Keeps the full board available for operators without making it the trading API.
- Converts source-ref mismatch and missing material-reentry receipts into release-condition reason codes.
- Preserves serving readiness as separate from material readiness.
- Keeps live and paper capital blocked.

Disadvantages:

- Adds one Jangar reducer and tests.
- Requires careful freshness handling.
- May still deny reentry when evidence is unchanged, which can look like no progress unless the handoff names it.

Decision: select Option C.

## Architecture

Jangar emits `jangar.verify-trust-foreclosure-carry.v1`.

Required shape:

```text
schema_version: jangar.verify-trust-foreclosure-carry.v1
carry_id
generated_at
fresh_until
mode
status
namespace
board_ref:
  board_id
  execution_trust_status
  source_rollout_truth_state
  active_no_delta_release_key
selected_ticket:
  ticket_id
  debt_class
  state
  expected_delta
  required_output_receipt
  validation_commands
  dedupe_key
  ttl_seconds
torghut_reentry_context:
  consumer_evidence_ref
  alpha_repair_closure_board_ref
  alpha_closure_settlement_market_ref
  selected_hypothesis_id
  selected_value_gate
  routeable_candidate_count
  max_notional
repair_slot_reconciliation:
  status
  selected_slot_id
  source_revenue_repair_ref_state
  material_reentry_receipt_state
  stage_credit_state
  release_condition
decision
reason_codes
rollback_target
```

Selection policy:

1. Prefer a ticket whose `debt_class` directly blocks the current Torghut alpha no-delta release:
   `revenue_repair_settlement_custody_deny`, `torghut_business_repair_only`, `route_stability_hold`, or
   `verify_trust_degraded`.
2. Do not select `torghut_no_delta_active` as an opening ticket when Torghut already consumed the no-delta budget.
   Preserve it as denial evidence.
3. If repair-slot escrow reports `selected_receipt_source_revenue_repair_ref_mismatch`, set release condition
   `source_revenue_repair_ref_changed`.
4. If material reentry receipt is missing, set release condition `required_receipt_set_changed`.
5. If stage credit is stale or held, set release condition `jangar_verify_foreclosure_ticket_current` and require the
   Jangar ticket receipt.
6. If no selected ticket is safe, emit `status=blocked` with no selected ticket and keep `max_notional=0`.

Freshness policy:

- `fresh_until` must be the minimum valid freshness across the verify board, Torghut consumer evidence, material gate
  digest, and repair-slot escrow.
- If no upstream freshness is valid, default to 60 seconds.
- Expired carry is still emitted for observability, but Torghut must treat it as stale denial evidence.

## Implementation Scope

Jangar engineer responsibilities:

1. Add a pure reducer that builds `verification_carry` from verify-trust foreclosure, material gate digest,
   repair-slot escrow, and Torghut consumer evidence.
2. Add TypeScript types for the compact carry packet.
3. Project the packet on `/ready` and `/api/agents/control-plane/status?namespace=agents`.
4. Optionally expose a dedicated Torghut route for the same packet after the ready/status projections are stable.
5. Add tests for current carry, stale carry, unavailable board, denied no-delta ticket, source-ref mismatch,
   material-reentry missing, and max-notional zero enforcement.
6. Keep the full verify board and repair-slot escrow unchanged for operator debugging.

Torghut responsibilities are defined in the companion contract.

## Validation Gates

Local Jangar validation:

- `env -u CODEX_STAGE bun run test services/jangar/src/server/__tests__/control-plane-verify-trust-foreclosure.test.ts`
- `env -u CODEX_STAGE bun run test services/jangar/src/server/__tests__/control-plane-repair-slot-escrow.test.ts`
- `env -u CODEX_STAGE bun run test services/jangar/src/routes/ready.test.ts`
- `bunx tsc --noEmit --project services/jangar/tsconfig.paths.json`
- `bun run --cwd services/jangar lint:oxlint`
- `bun run --cwd services/jangar lint:oxlint:type`

Post-rollout validation:

- `kubectl get applications.argoproj.io -n argocd agents jangar torghut`
- `kubectl get deploy -n jangar -o wide`
- `kubectl get deploy -n agents -o wide`
- `curl -fsS http://jangar.jangar.svc.cluster.local/ready | jq '.verification_carry'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.verification_carry'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.no_delta_repair_reentry_auction.jangar_verification_carry'`

Acceptance gates:

- Jangar emits `schema_version=jangar.verify-trust-foreclosure-carry.v1`.
- Carry includes one selected ticket or an explicit blocked reason.
- Carry includes `active_no_delta_release_key` when Torghut no-delta is active.
- Carry includes source-ref and material-reentry reconciliation states.
- Carry never opens nonzero notional.
- Torghut stops reporting `jangar_verification_carry_unavailable` once it consumes a fresh packet.

## Rollout

1. Ship carry export in observe mode.
2. Confirm `/ready` and control-plane status include the packet without changing existing verify-board fields.
3. Ship Torghut ingestion after the Jangar packet is live.
4. Keep material gate and repair-slot decisions conservative until Torghut proves the packet changes the auction
   reason set.
5. Promote only through CI and GitOps.
6. Record carry id, selected ticket, active no-delta release key, Torghut auction id, routeable candidate count, and
   max notional in the deployer handoff.

## Rollback

- Remove the dedicated carry route if it causes serving risk.
- Keep `/ready` serving truth independent from carry export.
- Keep verify-trust foreclosure board and repair-slot escrow as operator/debug surfaces.
- Let Torghut fall back to `jangar_verification_carry_unavailable`.
- Keep `dispatch_repair` denied, normal dispatch held, paper/live blocked, and Torghut `max_notional=0`.

## Risks

- **Schema sprawl:** the carry packet must stay compact. Do not export the full board by another name.
- **False release:** source-ref mismatch and material-reentry-missing are release-condition hints, not permission to
  launch unless Torghut's auction selects the ticket.
- **Freshness confusion:** expired carry must be visible but denied.
- **Double authority:** Jangar names the carry; Torghut decides whether it changes the revenue-repair auction.
- **No immediate PnL:** the first successful rollout may only replace an unavailable-carry denial with a current-carry
  denial. That still improves evidence quality and reduces duplicate no-delta work.

## Handoff

Engineer:

- Build the compact carry reducer and projection first.
- Keep it pure and deterministic so tests can assert selected ticket, reason codes, release condition, and freshness.
- Do not widen material action or capital behavior in the same change.

Deployer:

- Validate Jangar carry export before enabling Torghut ingestion.
- Treat `status=blocked` with clear reason codes as a valid rollout outcome if Torghut no-delta remains active.
- Keep proof of image digest, Argo sync, workload readiness, Jangar carry id, Torghut auction decision, and
  `max_notional=0`.

Smallest blocker preventing revenue impact:

- Jangar has verify-trust foreclosure evidence, but it is not exported as a compact carry packet that Torghut can
  consume; Torghut therefore keeps `routeable_candidate_count=0` and denies no-delta reentry with
  `jangar_verification_carry_unavailable`.
