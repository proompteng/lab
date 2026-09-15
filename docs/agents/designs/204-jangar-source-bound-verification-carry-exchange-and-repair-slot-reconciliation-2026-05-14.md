# 204. Jangar Source-Bound Verification Carry Exchange And Repair Slot Reconciliation (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar foreclosure-board export, Torghut verification-carry import, repair-slot source binding, stage-credit
reconciliation, zero-notional repair dispatch, validation, rollout, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/210-torghut-source-bound-verification-carry-import-and-no-delta-release-2026-05-14.md`

Extends:

- `203-jangar-foreclosure-carry-rollout-witness-and-stage-debt-repair-2026-05-14.md`
- `202-jangar-verification-carry-export-and-repair-slot-reconciliation-2026-05-14.md`
- `201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `docs/torghut/design-system/v6/209-torghut-verification-carry-import-and-alpha-repair-release-2026-05-14.md`
- `docs/torghut/design-system/v6/206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`

## Decision

I am selecting a **source-bound verification carry exchange with repair-slot reconciliation** as the next Jangar
control-plane contract.

The live evidence has moved since the previous architecture note. Jangar now emits
`verify_trust_foreclosure_board` from `/ready`; the old problem of a source-only board is no longer the whole story.
At 2026-05-14T16:28Z, Jangar `/ready` returned `status=ok`, `business_state=repair_only`,
`revenue_ready=false`, and a `jangar.verify-trust-foreclosure-board.v1` payload. That board correctly blocked
`dispatch_repair`, held `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked
`live_micro_canary` plus `live_scale`. It also opened tickets for execution trust, stage trust, verify trust,
plan trust, source rollout truth, controller witness, database projection, Torghut business repair-only, and revenue
repair settlement custody.

Torghut still cannot spend that carry. At the same time, Torghut `/trading/revenue-repair` returned
`verification_carry_import_board=null`; the no-delta auction denied reentry with
`jangar_verification_carry_unavailable`; and `/trading/consumer-evidence` exposed no imported verification-carry
board. Jangar's own `repair_slot_escrow` also blocked the selected zero-notional dispatch slot because of
`selected_receipt_source_revenue_repair_ref_mismatch`, `material_reentry_clearinghouse_missing`, and
`stage_credit_ledger_missing`.

That is the important system failure. The control plane can now produce a foreclosure board, but it does not yet bind
that board to the exact Torghut revenue-repair digest, no-delta release key, selected receipt, material reentry
receipt, and stage-credit ledger that Torghut is using to decide whether another alpha repair is safe. Without this
binding, one side can be current while the other side still sees the carry as unavailable.

The selected design makes Jangar export a compact `source_bound_verification_carry_exchange` and requires repair-slot
escrow to reconcile on the same source tuple before any `dispatch_repair` ticket can open. The tuple is:

- Torghut source revenue-repair ref;
- active no-delta release key;
- selected hypothesis id;
- selected value gate;
- selected executable alpha receipt id;
- Jangar foreclosure board id;
- Jangar material reentry receipt id;
- Jangar stage-credit ledger id;
- freshness window.

If the tuple does not match, Jangar does not classify the system as "almost ready"; it emits a source-bound mismatch
and keeps `dispatch_repair` blocked. If the tuple matches and the only remaining debt is a named zero-notional
prerequisite, Jangar can open exactly one repair slot with `max_parallelism=1`, `max_notional=0`, and the validation
command that proves either a routeable-candidate delta or an explicit no-delta settlement.

The tradeoff is extra strictness. A fresh Jangar board will not be enough to admit a repair; it must be the board
Torghut actually imported for the same revenue-repair digest. I accept that. The business metric is routeable
post-cost profit evidence under capital safety, not more repair attempts.

## Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value-gate mapping:

- `routeable_candidate_count`: one reconciled repair slot must target a measurable routeable-candidate movement or
  record no-delta debt against the exact source tuple.
- `zero_notional_or_stale_evidence_rate`: stale carry, missing carry, or source-ref mismatch keeps repair dispatch
  blocked.
- `fill_tca_or_slippage_quality`: execution-TCA work can be admitted only when the source-bound tuple says it is the
  selected prerequisite for the top alpha-readiness lane.
- `post_cost_daily_net_pnl`: no paper or live capital follows from this exchange; positive post-cost proof remains a
  later gate.
- `capital_gate_safety`: all admitted slots stay `max_notional=0`; live submission remains disabled.

Jangar control-plane mapping:

- `failed_agentrun_rate`: duplicate no-delta repair launches remain denied while the tuple is stale or mismatched.
- `pr_to_rollout_latency`: deployers get a single exchange packet that names source, live board, selected Torghut
  receipt, and reconciliation state.
- `ready_status_truth`: `/ready.status=ok` stays serving truth and no longer implies material repair authority.
- `manual_intervention_count`: no human has to manually compare Jangar `/ready`, Torghut `/trading/revenue-repair`,
  and Torghut `/trading/consumer-evidence` to understand why repair dispatch is blocked.
- `handoff_evidence_quality`: engineer and deployer handoffs cite exchange id, tuple hash, selected slot, denial
  reason, validation command, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, GitOps
resources, trading flags, AgentRuns, or market data.

### Cluster And Rollout

- The working branch was refreshed to `origin/main` at `c1020e9fd861b5ee122d0ba36d125901863af942`.
- Argo CD reported `torghut` `Synced` and `Healthy` at `c1020e9fd861b5ee122d0ba36d125901863af942`.
- Argo CD reported `jangar` `Synced` and `Healthy` at `a5c72fdb1ac94afd4755fabb9c56f36d9f3cbdda`.
- Argo CD reported `agents` `OutOfSync` and `Healthy` at `df84e741720c98447b4548906040bcdf6a829b6e`.
- Jangar namespace deployments `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar` were available.
- Agents namespace deployments `agents`, `agents-alloy`, and `agents-controllers` were available; controllers had
  two ready replicas.
- Torghut live revision `torghut-00399` and sim revision `torghut-sim-00496` were running.
- Torghut database migration job completed during the observed rollout.
- Recent Torghut events showed normal revision replacement, transient startup/readiness probe failures, completed
  whitepaper and empirical jobs, one active `torghut-profit-wide` workflow, and historical failed profit-feedback and
  whitepaper-autoresearch workflow pods.
- The service account could read workload state but could not exec into the Torghut database pod:
  `pods "torghut-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`.

### Jangar Control Plane

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`, `business_state=repair_only`, and
  `revenue_ready=false`.
- `execution_trust.status=degraded` because `jangar-control-plane:verify` was stale.
- `verify_trust_foreclosure_board.schema_version=jangar.verify-trust-foreclosure-board.v1`.
- The board mode was `observe`, board id was `verify-trust-foreclosure-board:agents:dfadea760cd07d9f`, and its
  `fresh_until` was one minute after generation.
- `dispatch_repair` was blocked by execution-trust, stage-trust, verify-trust, plan-trust, source-rollout-truth,
  Torghut no-delta, alpha-repair-dividend, alpha-readiness repeat-launch, alpha-closure, and revenue-repair
  settlement-custody reasons.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary` were held.
- `live_micro_canary` and `live_scale` were blocked by `torghut_business_repair_only` and `torghut_no_delta_active`.
- `repair_slot_escrow.status=block`.
- The blocked slot reason codes were `selected_receipt_source_revenue_repair_ref_mismatch`,
  `material_reentry_clearinghouse_missing`, and `stage_credit_ledger_missing`.

### Torghut Business Evidence

- `GET /trading/revenue-repair` generated at `2026-05-14T16:28:24.776278+00:00`.
- `business_state=repair_only`, `revenue_ready=false`, and the top queue item was `repair_alpha_readiness`.
- The top value gate was `routeable_candidate_count`; required output was `torghut.executable-alpha-receipts.v1`.
- Capital remained `zero_notional`, `max_notional=0`, and live submission remained disabled.
- `alpha_readiness_settlement_conveyor.status=no_delta`, `settlement_state=no_delta`, selected `H-MICRO-01`, and
  measured routeable candidate count `0 -> 0`.
- The selected no-delta release key was `3381ba65c903086a5f97a1f8`.
- `alpha_repair_dividend_ledger.status=no_delta`; `jangar_custody.launch_decision=deny`; paper and live classes were
  denied.
- `no_delta_repair_reentry_auction.reentry_decision=deny`.
- Auction reason codes included `active_no_delta_release_key`, `no_release_condition_changed`,
  `zero_notional_reentry_ticket_not_selected`, `jangar_verification_carry_unavailable`, and
  `duplicate_no_delta_reentry_denied`.
- `verification_carry_import_board=null`.

### Database And Data Quality

- Direct Postgres inspection through `kubectl cnpg psql` was blocked by Kubernetes RBAC on pod exec.
- The service-owned `/db-check` returned HTTP `200`, `ok=true`, and `schema_current=true`.
- Current and expected Alembic head was `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `schema_missing_heads=[]`, `schema_unexpected_heads=[]`, `schema_head_delta_count=0`, and
  `schema_graph_lineage_ready=true`.
- The database witness still reported historical parent forks under `0010_execution_provenance_and_governance_trace`
  and `0015_whitepaper_workflow_tables`.
- `/readyz` returned HTTP `503` because `live_submission_gate=simple_submit_disabled` and
  `profitability_proof_floor=repair_only`; Postgres, ClickHouse, Alpaca, database schema, and static universe were OK.
- Data-quality blockers were not schema-head blockers. They were alpha readiness, empirical jobs not ready, stale
  market-context news, source-bound Jangar carry absence on Torghut, and no routeable-candidate movement.

### Source And Test Surface

- Jangar foreclosure board source is `services/jangar/src/server/control-plane-verify-trust-foreclosure.ts`
  (`558` lines).
- Jangar `/ready` wiring is `services/jangar/src/routes/ready.tsx` (`419` lines).
- Jangar status wiring is `services/jangar/src/server/control-plane-status.ts` (`798` lines).
- Torghut revenue repair digest is `services/torghut/app/trading/revenue_repair.py` (`1180` lines).
- Torghut no-delta auction is `services/torghut/app/trading/no_delta_repair_reentry_auction.py` (`857` lines).
- Torghut API assembly remains high risk in `services/torghut/app/main.py` (`7005` lines).
- Existing Jangar tests cover foreclosure, repair-slot escrow, ready truth, material action verdict, material reentry,
  control-plane status, and Torghut runtime materialization.
- Missing test family: source-bound carry tuple match, source-ref mismatch denial, material reentry missing denial,
  stage-credit missing denial, Torghut import missing denial, tuple-current single-slot admission, and stale tuple
  expiry.

## Problem

Jangar and Torghut now both have useful pieces of the repair path, but they are not settling the same source tuple.

The concrete failure modes are:

1. Jangar emits a foreclosure board while Torghut still classifies Jangar carry as unavailable.
2. Jangar blocks repair-slot escrow because the selected Torghut receipt points at a different revenue-repair ref.
3. Material reentry and stage-credit receipts can be absent while the board still opens foreclosure tickets.
4. The active no-delta release key can differ across snapshots, making a repair slot look actionable to one service
   and stale to the other.
5. `/ready.status=ok` can be mistaken for dispatch authority even while `dispatch_repair` is explicitly blocked.
6. Deployer handoff can prove Jangar field presence without proving Torghut import.

The system needs a source-bound exchange, not another broad "is Jangar healthy" flag.

## Alternatives Considered

### Option A: Trust The Jangar Board Directly

This option lets Torghut reopen verification carry as soon as Jangar `/ready.verify_trust_foreclosure_board` exists.

Advantages:

- Simple to implement.
- Confirms the previous source-to-live rollout succeeded.
- Gives the no-delta auction a non-null Jangar object.

Disadvantages:

- It ignores the observed source-revenue-repair ref mismatch.
- It does not require material reentry or stage credit to exist.
- It can admit a repair slot for a stale no-delta release key.
- It lets field presence stand in for cross-plane settlement.

Decision: reject.

### Option B: Keep Blocking Until All Jangar Debt Clears

This option keeps `dispatch_repair` blocked until execution trust, stage trust, plan trust, verify trust, source
rollout truth, material reentry, stage credit, and Torghut no-delta debt are all clean.

Advantages:

- Safest possible posture.
- Easy to explain.
- Avoids repeated no-delta work.

Disadvantages:

- It does not identify the smallest repair slot that can retire the current blocker.
- It can hold zero-notional work behind unrelated stage debt.
- It does not improve `routeable_candidate_count`.
- It gives engineers no bounded implementation target.

Decision: reject as the operating model. Keep it as the fallback when the tuple is stale or mismatched.

### Option C: Source-Bound Verification Carry Exchange With Repair-Slot Reconciliation

This option requires Jangar to export and reconcile the source tuple before admitting one bounded zero-notional repair
slot.

Advantages:

- Directly targets the live mismatch.
- Separates serving health from material repair authority.
- Prevents duplicate no-delta repair launches.
- Gives Torghut a machine-readable import target.
- Gives deployers one acceptance packet to prove after rollout.
- Preserves capital safety.

Disadvantages:

- Adds another reducer and test family.
- Requires Jangar and Torghut payload schemas to evolve together.
- Can hold useful local work if the exchange TTL expires during market-open churn.

Decision: select Option C.

## Architecture

Jangar emits:

```text
jangar.source-bound-verification-carry-exchange.v1
  exchange_id
  generated_at
  fresh_until
  namespace
  mode
  torghut_source_revenue_repair_ref
  torghut_active_no_delta_release_key
  torghut_selected_hypothesis_id
  torghut_selected_value_gate
  torghut_selected_receipt_id
  foreclosure_board_id
  foreclosure_ticket_ids[]
  material_reentry_receipt_id
  stage_credit_ledger_id
  repair_slot_escrow_id
  tuple_hash
  tuple_state = current | source_ref_mismatch | release_key_mismatch | material_reentry_missing |
                stage_credit_missing | torghut_import_missing | stale | unavailable
  admission_decision = admit_one_zero_notional_slot | hold | block
  selected_slot
  reason_codes[]
  validation_commands[]
  rollback_target
```

The selected slot is optional and must include:

```text
repair_slot
  slot_id
  action_class = dispatch_repair
  ticket_class
  expected_gate_delta
  required_output_receipts[]
  max_parallelism = 1
  max_runtime_seconds <= 1800
  max_notional = 0
  dedupe_key = hash(tuple_hash, ticket_class, selected_value_gate)
  settlement_required = routeable_delta | no_delta_receipt
```

Admission rules:

1. `tuple_state=current` is required before `admit_one_zero_notional_slot`.
2. The exchange must reference the same Torghut revenue-repair ref and active no-delta release key that Torghut's
   import board reports.
3. Material reentry and stage-credit receipts are required for Jangar-owned dispatch authority.
4. `dispatch_repair` stays blocked when any source tuple field is missing, stale, or mismatched.
5. `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` do not
   inherit authority from this contract.
6. Every selected slot must be zero-notional and must preserve live submission disabled.
7. A slot that produces no routeable-candidate delta must write no-delta debt against the same tuple hash.

## Implementation Scope

Engineer milestone 1, Jangar:

- Add the exchange reducer near the foreclosure board and repair-slot escrow builders.
- Export the compact exchange through `/ready` and control-plane status.
- Bind repair-slot escrow to the exchange tuple and replace generic source-ref mismatch text with tuple-state fields.
- Add tests for current tuple, source-ref mismatch, release-key mismatch, missing material reentry, missing stage
  credit, stale tuple, and one-slot admission.

Engineer milestone 2, Torghut:

- Import the exchange into `verification_carry_import_board`.
- Feed the import state into `no_delta_repair_reentry_auction.release_conditions`.
- Export a compact reference on `/trading/consumer-evidence`.
- Add tests for Jangar current, unavailable, stale, source-ref mismatch, release-key mismatch, and missing stage-credit
  states.

Deployer milestone:

- Prove the exchange exists on live Jangar.
- Prove Torghut imports the same tuple.
- Prove `dispatch_repair` remains blocked while tuple state is not current.
- Prove one selected zero-notional slot appears only after tuple state is current and all required receipts exist.

## Validation Gates

Local Jangar validation:

```bash
bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-verify-trust-foreclosure.test.ts
bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-repair-slot-escrow.test.ts
bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts
```

Local Torghut validation:

```bash
uv run --frozen pytest services/torghut/tests/test_no_delta_repair_reentry_auction.py
uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair
uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py
```

Live read-only validation after rollout:

```bash
kubectl get applications.argoproj.io -n argocd torghut jangar agents -o wide
curl -fsS http://jangar.jangar.svc.cluster.local/ready | jq '.source_bound_verification_carry_exchange'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.verification_carry_import_board'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.no_delta_repair_reentry_auction'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.verification_carry_import_board'
```

Acceptance:

- Jangar exchange is non-null and fresh.
- Torghut import board is non-null and references the same tuple hash.
- Source-ref mismatch, release-key mismatch, missing material reentry, and missing stage credit are explicit states.
- `dispatch_repair` is blocked unless tuple state is current.
- No paper or live capital authority changes.
- The final handoff names `routeable_candidate_count` as the target revenue metric or names the exact tuple-state
  blocker preventing movement.

## Rollout

1. Ship Jangar exchange in observe mode.
2. Verify `/ready` and status expose the exchange without changing action decisions.
3. Ship Torghut import in observe mode.
4. Verify revenue-repair and consumer-evidence expose the imported tuple and keep no-delta reentry denied while the
   tuple is stale or mismatched.
5. Enable one-slot admission only after both services report the same tuple hash.
6. Keep all paper and live capital gates unchanged.

## Rollback

- Disable Jangar exchange emission or force `admission_decision=block`.
- Disable Torghut import consumption and fall back to `jangar_verification_carry_unavailable`.
- Keep `repair_slot_escrow.status=block`.
- Keep `max_notional=0`, live submission disabled, and no-delta release keys active.
- Revert to docs 203/209 behavior if the exchange causes payload compatibility issues.

## Risks

- The exchange can become stale during rapid revenue-repair digest refreshes. Mitigation: short TTL, tuple hash, and
  mismatch-specific denial.
- Cross-service schema drift can break import. Mitigation: versioned schemas and compact references on both sides.
- Engineers can overfit to `H-MICRO-01`. Mitigation: tuple includes selected hypothesis, value gate, and release key;
  a changed selection produces a new tuple.
- A zero-notional repair can still consume runner capacity without revenue impact. Mitigation: one-slot admission,
  no-delta settlement, and duplicate launch denial.

## Handoff

Engineer next action: implement the source-bound exchange and Torghut import board, with tests proving mismatch and
current-tuple behavior. The smallest revenue blocker is not capital. It is `verification_carry_import_board=null`
while Jangar emits a foreclosure board and repair-slot escrow reports source tuple blockers.

Deployer next action: after merge, prove Jangar and Torghut live endpoints show the same tuple hash before allowing any
zero-notional `dispatch_repair` slot. Do not widen paper or live capital.
