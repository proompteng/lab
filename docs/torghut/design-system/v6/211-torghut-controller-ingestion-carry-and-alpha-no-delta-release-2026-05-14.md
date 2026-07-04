# 211. Torghut Controller-Ingestion Carry And Alpha No-Delta Release (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut revenue-repair no-delta release conditions, Jangar controller-ingestion carry import, alpha-readiness
routeable-candidate repair, zero-notional guardrails, validation, rollout, rollback, and cross-swarm handoff.

Companion Jangar contract:

- `docs/agents/designs/205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`

Extends:

- `210-torghut-source-bound-verification-carry-import-and-no-delta-release-2026-05-14.md`
- `docs/agents/designs/204-jangar-source-bound-verification-carry-exchange-and-repair-slot-reconciliation-2026-05-14.md`
- `209-torghut-verification-carry-import-and-alpha-repair-release-2026-05-14.md`
- `208-torghut-jangar-verification-carry-bridge-and-no-delta-reentry-market-2026-05-14.md`
- `206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
- `205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`
- `docs/agents/designs/203-jangar-foreclosure-carry-rollout-witness-and-stage-debt-repair-2026-05-14.md`

## Decision

I am selecting **controller-ingestion carry as a first-class alpha no-delta release condition** for Torghut.

The live evidence is precise. `/trading/revenue-repair` is `repair_only`; top repair remains
`repair_alpha_readiness`; the selected value gate is `routeable_candidate_count`; the selected lane is `H-MICRO-01`;
accepted routeable candidates are still `0`; and capital is still `max_notional=0`. The alpha-readiness settlement
conveyor is doing the right thing: it records no delta and denies repeat launch while the release key is unchanged.

The next useful release condition is not another generic alpha repair attempt. The live no-delta auction already names
`jangar_verification_carry_unavailable`. Jangar status explains why: controller deployment and watch epoch are current,
but AgentRun ingestion self-report is missing, verification-carry fields are null, and normal stage clearance is held.
Torghut should import that as a typed state, not as an opaque blocker.

The selected design adds a compact import contract:
`torghut.jangar-controller-ingestion-carry.v1`. It classifies the Jangar carry as `current`, `repairable`, `lagging`,
`unavailable`, `stale`, or `contradicted`. The no-delta auction can then select exactly one zero-notional Jangar carry
repair ticket when Jangar says the missing witness is repairable. It must keep all alpha evidence tickets denied until
one of their real release conditions changes.

The tradeoff is that Torghut will continue to reject otherwise tempting alpha repair retries. I accept that. The
profit objective is not more repair volume. It is to move `routeable_candidate_count` with fresh, attributable evidence
while preserving capital safety.

## Governing Runtime Requirements

This contract implements the active cross-swarm runtime requirements:

- every implementation run must cite this design or its companion Jangar design before changing code;
- implement stages must ship production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, service health, and business evidence;
- final handoff must name the control-plane or revenue metric improved or the smallest blocker preventing improvement.

Jangar value-gate mapping:

- `failed_agentrun_rate`: deny duplicate alpha repair tickets while Jangar carry is unavailable and no release
  condition changed.
- `pr_to_rollout_latency`: Torghut classifies source-to-live carry state instead of waiting on vague deployment notes.
- `ready_status_truth`: Torghut refuses to treat Jangar serving health as material carry.
- `manual_intervention_count`: one import state replaces manual comparison of Jangar status and Torghut no-delta output.
- `handoff_evidence_quality`: release handoffs cite carry id, Jangar settlement id, selected lane, and validation
  commands.

Torghut value-gate mapping:

- `routeable_candidate_count`: no-delta release must be tied to a lane expected to change this value.
- `zero_notional_or_stale_evidence_rate`: stale or unavailable Jangar carry keeps the lane in repair-only denial.
- `fill_tca_or_slippage_quality`: execution TCA tickets remain separate release conditions and cannot bypass the top
  alpha-readiness queue.
- `post_cost_daily_net_pnl`: no paper or live widening is authorized by this contract.
- `capital_gate_safety`: all selected tickets must keep `max_notional=0`.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate database rows, Kubernetes resources, trading
flags, broker state, or market data.

### Revenue-Repair Surface

- `/trading/revenue-repair` returned `business_state=repair_only`.
- The repair queue included `repair_alpha_readiness` with reason `hypothesis_not_promotion_eligible`, priority
  `70`, value gate `routeable_candidate_count`, required output `torghut.executable-alpha-receipts.v1`, and
  `max_notional=0`.
- The same queue included lower-priority live-submit, empirical, degraded, and empirical-not-ready repairs.
- `alpha_readiness_settlement_conveyor.status=no_delta`.
- The selected lane was `H-MICRO-01`, strategy `microbar_volume_continuation_long_top2_chip_v1@paper`, lane
  `microstructure-breakout`, lane score `80`, and before reason `route_universe_empty`.
- `routeable_candidate_count_before=0`, `routeable_candidate_count_after=0`, and measured delta `0`.
- Required receipts still included `alpha_readiness_receipt`, `capital_replay_board`,
  `hypothesis_promotion_receipt`, `torghut.executable-alpha-receipts.v1`, and
  `torghut.alpha-readiness-settlement-receipt.v1`.

### No-Delta Auction Surface

- `no_delta_repair_reentry_auction.reentry_decision=deny`.
- Denial reasons included `active_no_delta_release_key`, `no_release_condition_changed`,
  `zero_notional_reentry_ticket_not_selected`, `jangar_verification_carry_unavailable`, and
  `duplicate_no_delta_reentry_denied`.
- Candidate tickets for alpha evidence, schema lineage, empirical, market context, execution TCA, and Jangar verify
  carry were denied because the release key was unchanged.
- The `jangar_verification_carry` block had `status=unavailable`, `jangar_foreclosure_board_ref=null`, and required
  receipt `jangar.verify-trust-foreclosure-ticket.v1`.

### Data And Schema Surface

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, and
  `schema_graph_lineage_ready=true`.
- The schema graph still reports historical parent-fork warnings, so this contract does not infer readiness from
  database head alone. It consumes application-level lineage and carry receipts.
- The live posture remains zero-notional. This contract does not enable live submit, paper canary, or live scale.

### Jangar Import Surface

- Jangar `/ready` returned `status=ok` and a fresh material gate digest, but `/ready.ready_truth_arbiter` was null.
- Full Jangar status reported database healthy and migrations current, but `execution_trust=degraded`.
- Full Jangar status had `verify_trust_foreclosure_board=null` and `repair_slot_escrow=null`.
- Controller witness was `repair_only` because controller deployment and watch epoch were current while AgentRun
  ingestion self-report was unknown.

## Problem

Torghut has a correct no-delta guard, but the guard does not yet know whether the Jangar-side blocker is:

1. a source-to-serving rollout lag;
2. a missing live verification-carry field;
3. stale controller ingestion evidence;
4. a repairable Jangar witness gap;
5. a contradictory Jangar state; or
6. a true alpha-readiness release condition that changed.

Without that distinction, Torghut has two bad options: deny everything and leave the operator to interpret Jangar, or
launch generic alpha repair against an unchanged no-delta key. Both lose leverage.

## Alternatives Considered

### Option A: Keep Jangar Carry As A Text Reason Code

Torghut continues to emit `jangar_verification_carry_unavailable` and lets Jangar or operators interpret it.

Advantages:

- No new schema.
- No immediate Torghut implementation cost.
- Existing no-delta denial remains safe.

Disadvantages:

- Does not create a bounded Jangar repair lane.
- Does not distinguish unavailable from stale, lagging, or contradicted.
- Leaves handoffs to summarize two large status payloads.
- Does not improve routeable candidate count.

Decision: reject as architecture.

### Option B: Treat Jangar Source SHA As Enough Carry

Torghut accepts a Jangar source commit or design reference as proof that verification carry is available.

Advantages:

- Easy to implement.
- Fast path to selecting a Jangar carry ticket.
- Reduces dependence on status payload shape.

Disadvantages:

- The live evidence disproves it: source and design can exist while live status fields are null.
- It weakens ready-status truth.
- It could allow repeated alpha repair before Jangar can explain material action authority.
- It has poor rollback semantics.

Decision: reject.

### Option C: Import Jangar Controller-Ingestion Carry

Torghut imports the companion Jangar settlement and classifies carry before the no-delta auction selects a release
ticket.

Advantages:

- Targets the live blocker.
- Keeps duplicate alpha repair denied.
- Allows one zero-notional Jangar carry repair if Jangar proves the witness gap is repairable.
- Produces a compact business-evidence field for Jangar and deployer handoffs.
- Preserves capital safety.

Disadvantages:

- Adds one import model and tests.
- Requires stable Jangar settlement field names.
- Keeps alpha lanes denied until the carry classification improves.

Decision: select Option C.

## Architecture

Torghut adds a compact import to revenue repair and consumer evidence:

```yaml
schema_version: torghut.jangar-controller-ingestion-carry.v1
carry_id: jangar-controller-ingestion-carry:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
source_jangar_settlement_ref: <controller-ingestion-settlement id|null>
jangar_settlement_decision: allow|repair_only|hold|block|unknown
jangar_controller_ingestion_current: true|false|null
jangar_verify_foreclosure_board_ref: <id|null>
jangar_repair_slot_escrow_ref: <id|null>
carry_state: current|repairable|lagging|unavailable|stale|contradicted
selected_release_condition: jangar_controller_ingestion_current
selected_ticket_class: jangar_verify_carry|none
max_notional: '0'
reason_codes: []
validation_commands: []
rollback_target: <string>
```

Carry classification:

- `current`: Jangar settlement is `allow`, ingestion is current, verification carry fields are present, and Torghut
  can cite the refs.
- `repairable`: Jangar settlement is `repair_only` and selects a bounded Jangar carry repair ticket.
- `lagging`: source or GitOps claims carry, but live fields are absent.
- `unavailable`: Jangar settlement or carry fields are missing.
- `stale`: the Jangar settlement exists but is expired.
- `contradicted`: Jangar reports allow while required fields are absent, or reports incompatible image/source refs.

No-delta release rules:

1. Keep alpha evidence tickets denied while source ref, evidence window, blocker set, required receipts, and selected
   hypothesis are unchanged.
2. Permit a `jangar_verify_carry` ticket only when carry state is `repairable`.
3. Deny all tickets when carry state is `unavailable`, `stale`, `lagging`, or `contradicted`.
4. Keep `max_notional=0` for every selected ticket.
5. Do not promote paper or live capital from carry state alone.

## Measurable Trading Hypotheses

H-MICRO-01 is the active repair hypothesis.

- Hypothesis: once Jangar controller-ingestion carry is current, H-MICRO-01 can be re-evaluated against a changed
  route universe or evidence window and produce `routeable_candidate_count > 0` without increasing notional.
- Required receipts: `torghut.alpha-readiness-settlement-receipt.v1`, `torghut.executable-alpha-receipts.v1`,
  `alpha_readiness_receipt`, `hypothesis_promotion_receipt`, and `capital_replay_board`.
- Guardrail: deny repeat launch if measured routeable-candidate delta remains `0` and no release condition changed.

H-CONT-01 remains held.

- Hypothesis: continuation may become routeable after TCA evidence is current.
- Guardrail: do not let H-CONT-01 overtake H-MICRO-01 unless the selected value gate or blocker set changes.

H-REV-01 remains held.

- Hypothesis: event reversion may become routeable after TCA evidence is current.
- Guardrail: keep repeat launch denied while its no-delta key is active.

Success metric for the next implementation window:

- `routeable_candidate_count` increases above `0`, or the handoff proves the smallest blocker remains
  `jangar_controller_ingestion_current=false` or unchanged no-delta release conditions.

## Implementation Scope

Milestone 1: import contract and no-delta classifier.

- Add a compact import model for Jangar controller-ingestion carry.
- Extend the no-delta auction to classify carry state.
- Add tests for current, repairable, lagging, unavailable, stale, and contradicted.
- Value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, `handoff_evidence_quality`.

Milestone 2: consumer evidence projection.

- Mirror the compact carry on `/trading/consumer-evidence`.
- Keep `/readyz` degraded for capital safety when no-delta is active.
- Value gates: `ready_status_truth`, `manual_intervention_count`.

Milestone 3: repair ticket selection.

- Select one `jangar_verify_carry` ticket only when Jangar classifies the gap as repairable.
- Keep max parallelism `1`, max runtime bounded, and max notional `0`.
- Value gates: `failed_agentrun_rate`, `capital_gate_safety`.

Milestone 4: rollout proof.

- Verify Argo, workload readiness, Torghut `/db-check`, `/trading/revenue-repair`, `/trading/consumer-evidence`, and
  Jangar status before claiming release.
- Value gates: `pr_to_rollout_latency`, `handoff_evidence_quality`.

## Validation Gates

Local Torghut validation:

- `cd services/torghut && uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py`
- `cd services/torghut && uv run --frozen pytest tests/test_alpha_readiness_settlement_conveyor.py`
- `cd services/torghut && uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k revenue_repair`
- `cd services/torghut && uv run --frozen ruff check app/trading tests`
- `cd services/torghut && uv run --frozen ruff format --check app/trading tests`

Runtime validation:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence`
- `curl -fsS http://torghut.torghut.svc.cluster.local/db-check`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
- `kubectl get applications.argoproj.io -n argocd agents jangar torghut`

Acceptance gates:

- revenue repair still reports `repair_only` until routeable candidates improve;
- alpha no-delta duplicate tickets remain denied while release conditions are unchanged;
- Jangar carry state appears with a fresh id and reason codes;
- a Jangar carry ticket is selected only when carry state is `repairable`;
- all selected work remains `max_notional=0`;
- handoff names whether `routeable_candidate_count` moved or the smallest blocker preventing movement.

## Rollout

Phase 0 is documentation and handoff.

Phase 1 emits the import field in observe mode and keeps existing no-delta decisions.

Phase 2 classifies carry state but does not select new tickets.

Phase 3 allows one zero-notional Jangar carry repair ticket when state is `repairable`.

Phase 4 allows alpha no-delta release only after a real release condition changes and Jangar carry is current.

Phase 5 is capital review only. This design does not authorize paper or live widening.

## Rollback

Rollback is field-level:

- stop emitting `jangar_controller_ingestion_carry`;
- keep existing no-delta auction and alpha-readiness conveyor behavior;
- keep `max_notional=0`;
- keep live submit disabled until capital-release designs prove otherwise.

No database migration is required for the first implementation. If later work persists carry history, it must use
Alembic migration guards and `/db-check` must remain schema-current.

## Risks

- Carry import can become stale if Jangar changes field names. Mitigation: schema-versioned import, explicit missing
  field reason codes, and tests for absent fields.
- Repairable state can select the wrong ticket. Mitigation: selected ticket must cite the Jangar settlement id and
  validation commands.
- Routeable candidate count can remain zero after carry is repaired. Mitigation: no-delta release remains active and
  the next blocker is named instead of retrying blindly.
- Operators can confuse zero-notional repair with capital readiness. Mitigation: all payloads keep `max_notional=0` and
  capital release out of scope.

## Handoff To Engineer

Start with the import classifier, not with capital or strategy changes. The first Torghut implementation PR should add
the model and tests that classify synthetic Jangar settlement payloads into `current`, `repairable`, `lagging`,
`unavailable`, `stale`, and `contradicted`.

Expected files:

- `services/torghut/app/trading/no_delta_repair_reentry_auction.py`
- `services/torghut/app/trading/revenue_repair.py`
- `services/torghut/app/main.py`
- `services/torghut/tests/test_no_delta_repair_reentry_auction.py`
- `services/torghut/tests/test_build_revenue_repair_digest.py`
- `services/torghut/tests/test_trading_api.py`

Do not change live submission, broker, or notional behavior. The output must remain repair-only unless a later capital
design says otherwise.

## Handoff To Deployer

Do not claim revenue repair is healthy because Torghut pods are ready. The deployer gate is:

1. PR merged with green Torghut tests.
2. Image promoted through GitOps.
3. Argo `torghut` is `Synced/Healthy`.
4. Torghut live and sim workloads are ready.
5. `/db-check` is schema-current.
6. `/trading/revenue-repair` shows the carry import state.
7. `/trading/consumer-evidence` mirrors the compact carry.
8. Jangar status shows the companion controller-ingestion settlement.
9. Final handoff says whether `routeable_candidate_count` moved above `0`; if not, it names the smallest blocker.
