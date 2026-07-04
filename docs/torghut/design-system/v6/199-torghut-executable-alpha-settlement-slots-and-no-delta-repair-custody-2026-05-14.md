# 199. Torghut Executable Alpha Settlement Slots And No-Delta Repair Custody (2026-05-14)

Status: Accepted for Jangar engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut executable-alpha repair receipt settlement, routeable candidate movement, no-delta debt, zero-notional
capital safety, validation, rollout, rollback, and Jangar slot handoff.

Companion Jangar contract:

- `docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`

Extends:

- `198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`
- `197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md`
- `197-torghut-alpha-readiness-strike-ledger-and-routeable-candidate-ladder-2026-05-13.md`
- `192-torghut-repair-receipt-frontier-and-profit-cutover-2026-05-13.md`
- `190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`

## Decision

I am selecting **executable alpha settlement slots** as Torghut's companion contract for Jangar receipt-settled repair
slots.

Torghut now exposes the right business target, but it still needs a compact before/after settlement object that Jangar
can use to decide whether one zero-notional repair slot retired debt, improved the blocker set, produced no delta, or
invalidated the hypothesis. On 2026-05-14, `GET /trading/revenue-repair` returned
`business_state=repair_only`, `revenue_ready=false`, top repair item `repair_alpha_readiness`, value gate
`routeable_candidate_count`, required output `torghut.executable-alpha-receipts.v1`, and selected repair receipt
`executable-alpha-repair-receipt:a0e37a7c9b96f322d6f6bbac`.

The selected receipt is useful but incomplete as settlement proof. It states the before position for `H-CONT-01`:
repair class `evidence_window_refresh`, expected delta `retire_post_cost_expectancy_non_positive`, max notional `0`,
and no-delta settlement required. It does not, by itself, tell Jangar whether the after run produced an
`alpha_readiness_receipt`, changed `routeable_candidate_count`, left a no-delta result, or superseded the slot because
the top queue changed.

The selected design adds a small `executable_alpha_settlement_slots` object to Torghut's revenue-repair and consumer
evidence surfaces. It keeps `/trading/revenue-repair` as the live business evidence surface, keeps max notional at
`0`, and gives Jangar one settlement contract per selected repair. It turns "I have a receipt to try" into "this
receipt can spend one Jangar slot and must settle with one of these outcomes."

The tradeoff is stricter repair accounting. A repair PR can be technically useful and still settle as no-delta if the
routeable candidate count, blocker set, or required after receipts do not move. I accept that because Torghut's active
business blocker is routeable revenue reentry, not generic proof accumulation.

## Governing Runtime Requirements

This contract follows the active Jangar validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Torghut value gates:

- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `post_cost_daily_net_pnl`
- `capital_gate_safety`

Jangar value gates affected:

- `failed_agentrun_rate`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Current Evidence

All evidence was collected read-only on 2026-05-14.

### Business Surface

- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned
  `schema_version=torghut.revenue-repair-digest.v1`, `business_state=repair_only`, and `revenue_ready=false`.
- Top repair queue item:
  - `code=repair_alpha_readiness`
  - `reason=hypothesis_not_promotion_eligible`
  - `dimension=alpha_readiness`
  - `action=clear_hypothesis_blockers_before_capital`
  - `priority=70`
  - `expected_unblock_value=4`
  - `value_gate=routeable_candidate_count`
  - `required_output_receipt=torghut.executable-alpha-receipts.v1`
  - `required_receipts=alpha_readiness_receipt,hypothesis_promotion_receipt,capital_replay_board`
  - `max_notional=0`
  - `capital_rule=zero_notional_repair_only`
- Second repair queue item was `live_submit_gate_closed` with `simple_submit_disabled`, which must remain downstream
  until alpha readiness and proof-floor evidence improve.
- `executable_alpha_repair_receipts.status=selected`, with three receipts and selected receipt
  `executable-alpha-repair-receipt:a0e37a7c9b96f322d6f6bbac`.
- Selected receipt:
  - hypothesis `H-CONT-01`
  - candidate `chip-paper-microbar-composite@execution-proof`
  - strategy `intraday_tsmom_v1@paper`
  - repair class `evidence_window_refresh`
  - expected delta `retire_post_cost_expectancy_non_positive`
  - before routeable candidate count `0`
  - required outputs `alpha_readiness_receipt`, `capital_replay_board`, `hypothesis_promotion_receipt`, and
    `torghut.executable-alpha-receipts.v1`
  - validation command
    `uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window`
  - max notional `0`
  - capital rule `zero_notional_repair_only`
  - no-delta settlement required

### Runtime And Cluster

- Argo: `torghut=Synced/Healthy/Succeeded` at `567e9ca3831d028fd2e978ad6dd27b76c87b59f4`.
- Active Torghut serving revision: `torghut-00371`, image digest
  `sha256:8d3a43bed9c6da942827c5e25f40fc88d1b0712a99a172831da222eebc820c4d`, source commit
  `8d84f9f5ce028214bfb5326e0791638bc35625f5`.
- Active Torghut live and sim deployments were ready (`torghut-00371=1/1`, `torghut-sim-00469=1/1`).
- Torghut DB, ClickHouse, Keeper, options catalog, options enricher, TA, TA sim, WebSocket, and guardrail exporters
  were running.
- Recent Torghut whitepaper autoresearch pods had a long error tail while a current pod was running. That is not the
  current revenue-repair blocker, but it reinforces the need for no-delta repair custody and dedupe.

### Database And Data Quality

- `GET http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503 with `status=degraded`.
- Dependencies were healthy or acceptable: Postgres, ClickHouse, Alpaca, universe, empirical jobs, DSPy runtime, and
  optional quant evidence.
- Database schema was current at Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`, with no missing or
  unexpected heads and lineage ready.
- Known schema graph parent-fork warnings remain under `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Live submission was blocked by `simple_submit_disabled`.
- Profitability proof floor was `repair_only`.
- Capital stage was `shadow`, capital state was `zero_notional`, and max notional was `0`.
- Execution TCA data exists but routeability is not ready: 7,334 orders, 7,245 filled executions, average absolute
  slippage 13.82 bps, one routeable symbol, four blocked symbols, and three missing symbols.
- Alpha readiness had three repair targets and zero promotion-eligible hypotheses.

## Problem

Torghut can now nominate a repair receipt, but Jangar needs settlement custody before it can trust one runner slot.

The current failure modes are:

1. A selected executable alpha repair receipt can be retried without proving any routeable-candidate movement.
2. The after evidence is not compact. Jangar would need to compare revenue repair, alpha readiness, TCA, market
   context, and proof-floor payloads manually.
3. A no-delta repair can be useful context but should not keep consuming slots with the same dedupe key.
4. If the top queue item changes while a slot is running, the old receipt must settle as superseded, not as a fresh
   launch candidate.
5. Capital must remain zero-notional while the repair is running and after it settles.

The architecture needs an object that binds selected repair, before state, after state, outcome, and Jangar slot ref.

## Alternatives Considered

### Option A: Treat `executable_alpha_repair_receipts.selected_receipt` As The Settlement Object

Torghut would leave the existing selected receipt unchanged and Jangar would infer settlement by polling the full
revenue-repair digest later.

Advantages:

- No new payload shape.
- Minimal implementation work.
- Keeps one obvious repair object.

Disadvantages:

- The selected receipt is a before contract, not an after receipt.
- No-delta and superseded outcomes remain implicit.
- Jangar has to diff large payloads and reason-code lists.
- Repeated no-delta launch blocking would be fragile.

Decision: reject. The selected receipt remains the launch candidate, but settlement needs its own compact object.

### Option B: Write Settlement Only To Database Tables

Torghut records repair settlement rows in Postgres and exposes them later through analytics.

Advantages:

- Durable persistence.
- Natural fit for longer repair history.
- Good for offline profitability review.

Disadvantages:

- Jangar's current read path is HTTP control-plane evidence, not direct DB access.
- This AgentRun's service account cannot read Torghut DB directly, and that least-privilege boundary is intentional.
- It does not give schedule-runner admission a fresh compact object.

Decision: reject as the primary action boundary. Persist later if needed, but publish the compact status object first.

### Option C: Executable Alpha Settlement Slots

Torghut emits `executable_alpha_settlement_slots` next to the selected repair receipt. Each slot carries before refs,
after refs, Jangar slot ref, settlement state, measured delta, no-delta debt, and rollback target.

Advantages:

- Gives Jangar a compact after-proof contract.
- Keeps `/trading/revenue-repair` as the live business evidence surface.
- Makes no-delta repeats visible and deniable.
- Preserves zero-notional capital safety.
- Lets the engineer stage test a pure builder before changing runtime admission.

Disadvantages:

- Adds a new payload and tests.
- Requires stable linking between Jangar slot id and Torghut settlement slot.
- Needs careful handling when the selected receipt changes mid-run.

Decision: select Option C.

## Architecture

Torghut adds `executable_alpha_settlement_slots`.

```text
executable_alpha_settlement_slots
  schema_version = torghut.executable-alpha-settlement-slots.v1
  generated_at
  fresh_until
  source_revenue_repair_ref
  selected_receipt_id
  selected_slot_id
  status = inactive | selected | running | settled | blocked
  slots[]
  no_delta_debt[]
  rollback_target
```

Each slot:

```text
executable_alpha_settlement_slot
  schema_version = torghut.executable-alpha-settlement-slot.v1
  slot_id
  jangar_repair_slot_id
  selected_receipt_id
  source_revenue_repair_ref
  hypothesis_id
  candidate_id
  strategy_id
  repair_class
  target_value_gate
  expected_gate_delta
  before_reason_codes[]
  before_value_gate
  before_refs[]
  required_output_receipts[]
  validation_commands[]
  after_reason_codes[]
  after_value_gate
  after_refs[]
  measured_delta
  settlement_state = pending | retired | improved | no_delta | invalidated | failed | superseded
  no_delta_reason
  dedupe_key
  max_notional = 0
  capital_rule = zero_notional_repair_only
  rollback_target
```

Settlement rules:

1. A slot can be `selected` only when the revenue-repair top queue item is `repair_alpha_readiness`.
2. A slot can be `running` only when Jangar returns a matching `jangar.repair-slot-escrow.v1` slot id.
3. The slot settles `retired` when the selected blocker is absent from the next current alpha-readiness evidence.
4. The slot settles `improved` when routeable candidate count, blocker count, or required receipt coverage improves
   but the top queue is not fully retired.
5. The slot settles `no_delta` when after evidence is current but the blocker set and value gate do not improve.
6. The slot settles `superseded` when the top queue item changes before the repair completes.
7. The slot settles `failed` when the linked AgentRun fails for a repair-owned reason.
8. Any nonzero notional, enabled live submission, or missing zero-notional capital rule blocks the slot.

## Implementation Scope

M1: Build settlement slots as a pure projection.

- Implement near `services/torghut/app/trading/executable_alpha_receipts.py`.
- Consume the selected executable alpha repair receipt and optional Jangar repair slot ref.
- Emit a selected settlement slot with before value gate and no after refs.
- Tests:
  - selected receipt creates one selected settlement slot;
  - non-alpha top queue produces inactive status;
  - nonzero notional blocks;
  - stale selected receipt blocks.

M2: Add after-state settlement.

- Compare after alpha readiness, routeable candidate count, and required output receipts.
- Classify `retired`, `improved`, `no_delta`, `invalidated`, `failed`, or `superseded`.
- Tests:
  - blocker removed settles retired;
  - routeable candidate count increases settles improved;
  - unchanged blocker set settles no-delta;
  - top queue changed settles superseded.

M3: Expose the compact object.

- Add `executable_alpha_settlement_slots` to `/trading/revenue-repair`, `/trading/consumer-evidence`, and `/readyz`.
- Keep existing revenue repair, executable alpha repair receipts, capital replay board, and proof-floor payloads intact.
- Tests for endpoint payload shape should assert schema version, selected slot id, dedupe key, capital rule, and
  rollback target.

M4: Optional persistence.

- If repeated no-delta history is needed beyond status TTL, add a Postgres table in a later PR.
- The runtime gate must not depend on direct DB access from Jangar.

## Validation

Local validation for the first implementation PR:

- `uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py`
- `uv run --frozen pytest services/torghut/tests/test_revenue_repair.py -k executable_alpha`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Runtime validation after merge and promotion:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.executable_alpha_settlement_slots'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.executable_alpha_settlement_slots'`
- `curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://torghut.torghut.svc.cluster.local/readyz`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.repair_slot_escrow'`

Acceptance gates:

- Top queue `repair_alpha_readiness` produces one selected settlement slot and no paper/live capital permission.
- Settlement slot names the selected executable alpha repair receipt and Jangar repair slot when present.
- No-delta outcome produces debt with the same dedupe key.
- A changed receipt, changed blocker set, changed source revenue-repair ref, or improved value gate can supersede or
  clear the debt.
- Torghut remains `max_notional=0` and live submission remains disabled.

## Rollout

Phase 0 is this contract.

Phase 1 adds the pure builder and tests, with no endpoint exposure.

Phase 2 exposes the object on `/trading/revenue-repair` and `/trading/consumer-evidence` in observe mode.

Phase 3 lets Jangar attach `jangar_repair_slot_id` and records running/settled status.

Phase 4 persists no-delta history only if status TTL proves insufficient.

## Rollback

Rollback is safe because the object is additive:

1. Stop emitting `executable_alpha_settlement_slots`.
2. Keep `executable_alpha_repair_receipts`, revenue repair digest, repair-bid settlement, and capital replay board.
3. Keep live submission disabled and max notional `0`.
4. Do not delete repair receipts, AgentRuns, jobs, or database rows.
5. Jangar should fall back to holding the repair slot when settlement slots are missing.

## Risks

- Payload churn: the settlement slot could duplicate too much of revenue repair. Mitigation: include only selected
  refs, before/after value gates, outcome, and dedupe key.
- Source mismatch: Torghut source commit and Jangar source rollout truth can disagree. Mitigation: settlement remains
  selected but Jangar holds the slot until material reentry and source refs agree.
- No-delta false negatives: an implementation may improve diagnostics without moving routeable candidates. Mitigation:
  settle as no-delta but allow a changed blocker set or after receipt to reopen.
- Capital leak: a repair slot could be misread as capital approval. Mitigation: every slot carries max notional `0`,
  `zero_notional_repair_only`, and no paper/live action class.

## Handoff

Engineer handoff:

- Implement M1 and M2 in Torghut with deterministic tests before wiring Jangar admission.
- Use the current selected receipt shape from `/trading/revenue-repair` as the fixture.
- Do not enable paper or live submission.
- Emit settlement slots as additive status data only.

Deployer handoff:

- After promotion, verify `/trading/revenue-repair`, `/trading/consumer-evidence`, `/readyz`, Jangar `/ready`, and
  Jangar control-plane status.
- A successful deployment is not a capital release. It only proves Torghut can publish the settlement slot.
- Roll back by removing the additive object from payloads or disabling its builder; leave existing receipts intact.

Final metric target:

- Increase `routeable_candidate_count` through measured alpha repair attempts.
- Lower zero-notional stale-evidence churn by blocking repeated no-delta repairs.
- Improve Jangar `failed_agentrun_rate` by giving schedule-runner admission a concrete settlement object.
