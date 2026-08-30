# 197. Torghut Serving Promotion Closure And No-Delta Repair Value (2026-05-13)

Status: Accepted for Jangar engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

I am selecting **serving promotion closure with no-delta repair value accounting** as Torghut's companion architecture
for the Jangar promotion closure ledger.

Torghut is available but not revenue-ready. On 2026-05-13, Argo reported `torghut` `Synced/Healthy`, the current live
revision `torghut-00364` was ready, `/db-check` was schema-current at
`0031_autoresearch_candidate_spec_epoch_uniqueness`, and Postgres, ClickHouse, Alpaca, universe, readiness cache, DSPy
runtime, and empirical jobs were healthy. `/readyz` still returned HTTP `503` because live submission was blocked by
`simple_submit_disabled`, profitability proof floor was `repair_only`, capital remained zero-notional, and alpha
readiness had no promotion-eligible hypothesis.

The live business surface is `/trading/revenue-repair`. It reported `business_state=repair_only`,
`revenue_ready=false`, `32` raw repair bids compacted into `5` selected lots, `3` dispatchable lots, routeable count
`0`, and max notional `0`. The top dispatchable repair class is `quant_pipeline`; `feature_lineage` and
`execution_tca` are also dispatchable. This is useful work, but it still lacks one critical property: each dispatched
repair must prove whether it retired a blocker. A terminal repair without the expected receipt must become no-delta
debt, not a reason to launch the same lot again.

There is also a source-to-serving gap. The repository now contains `profit_carry_passports.py`, but the live Torghut
build reports commit `cde296cccb517ae640900ee9d01a13004a1ec6c2` and does not expose `profit_carry_passport_ledger`
from `/trading/status`, `/readyz`, or `/trading/consumer-evidence`. Jangar sees this as source/serving mismatch and
manifest image digest debt. Torghut should make that gap a first-class promotion closure receipt instead of relying on
humans to notice that source has moved ahead of serving.

The selected design keeps paper and live capital closed. It makes the current zero-notional repair queue more valuable
by requiring every selected lot to carry an expected blocker delta, a required receipt, a no-delta fallback, and a
serving promotion closure receipt when the source contract is not live yet.

## Governing Runtime Requirements

This companion contract follows the active Jangar validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Torghut value gates:

- `routeable_candidate_count`
- `fill_tca_or_slippage_quality`
- `zero_notional_or_stale_evidence_rate`
- `post_cost_daily_net_pnl`
- `capital_gate_safety`

Jangar value gates affected:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Read-Only Evidence Snapshot

All evidence was collected read-only on 2026-05-13.

### Cluster And Serving

- Argo `torghut` was `Synced/Healthy` at revision `d4703334a83b3fa8933486f56491626580eab8b6`.
- Argo `torghut-options` was `Synced/Healthy` at revision `6f1aa11d5a128d7cb6e42aa4aeb67660a380d57e`.
- The active live image was `sha256:90ac72f8bcdd8964dbca684e461e44daedbd143070f7d437ade6560c21a10db8`.
- `torghut-00364-deployment=1/1` and `torghut-sim-00462-deployment=1/1` were ready; older revisions were scaled down
  or terminating.
- Options catalog, options enricher, TA, TA sim, ClickHouse, Keeper, WebSocket services, guardrail exporters, and
  Torghut DB pods were running.
- Recent rollout events included startup and readiness probe failures that cleared before revision readiness. That is
  rollout friction, not an active serving outage.

### Database And Data Quality

- `/db-check` returned `ok=true`, `schema_current=true`, expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, current head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, and account scope ready.
- Migration graph lineage was ready but still reported known parent-fork warnings for historical branches under
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/readyz` dependencies were healthy for Postgres, ClickHouse, Alpaca, database schema, universe, readiness cache,
  DSPy runtime, empirical jobs, and quant evidence as optional.
- Live submission stayed blocked by `simple_submit_disabled`, with active capital stage `shadow`.
- Alpha readiness evaluated three hypotheses, kept all in `shadow`, had zero promotion eligible, and required rollback
  for all three.

### Revenue Repair And Source Parity

- `/trading/revenue-repair` returned `business_state=repair_only` and `revenue_ready=false`.
- Repair-bid settlement had `raw_repair_bid_count=32`, `5` selected lots, `3` dispatchable lots, `3` held lots,
  routeable count `0`, and max notional `0`.
- The selected dispatchable lots were `quant_pipeline`, `feature_lineage`, and `execution_tca`; held lots included
  rollout image and empirical replay due dispatch or selection limits.
- `/trading/consumer-evidence` exposed `repair_bid_settlement_ledger` but did not expose
  `profit_carry_passport_ledger`.
- Repository source includes `services/torghut/app/trading/profit_carry_passports.py` and tests, but the live image
  build commit is older than that source. This is the serving promotion closure gap.

## Problem

Torghut has moved from vague degraded readiness to a typed zero-notional repair queue. The next problem is not finding
more repair work. It is proving that the repair queue is source-current, value-ranked, and accountable.

The current failure modes are:

1. A source contract can exist in the repository while the live image does not expose it.
2. `/trading/revenue-repair` can name selected repair lots, but it does not yet publish a top queue item with no-delta
   accounting.
3. A repair can consume Jangar runner capacity without producing the receipt that retires the targeted blocker.
4. Held rollout-image and empirical-replay lots can be confused with unavailable work rather than lower-priority work.
5. Capital remains correctly closed, but routeability cannot improve until selected repair lots prove before/after
   movement.
6. Jangar has to infer Torghut source promotion state from build mismatch and missing manifest digest instead of a
   Torghut serving closure receipt.

## Alternatives Considered

### Option A: Keep Current Repair-Bid Settlement And Wait For Promotion

This path leaves `repair_bid_settlement_ledger` as the primary repair surface and treats profit-carry passports as a
future live rollout.

Advantages:

- No new Torghut payload.
- Preserves current zero-notional safety.
- Keeps selected repair lots available.

Disadvantages:

- Does not make source-to-serving gap explicit to Jangar.
- Does not require no-delta receipts.
- Does not explain why profit-carry source is absent from live payloads.
- Can repeat repairs without proving value movement.

Decision: reject as the next architecture. It is safe, but it leaves value accounting incomplete.

### Option B: Block All Repair Until Profit-Carry Passports Are Live

This path freezes Torghut repair dispatch until the live image exposes `profit_carry_passport_ledger`.

Advantages:

- Strong source/serving consistency.
- Avoids dispatching against stale source contracts.
- Easy for deployers to reason about.

Disadvantages:

- Deadlocks zero-notional repairs that could close routeability blockers now.
- Increases manual intervention.
- Does not use the already-current repair-bid settlement ledger.

Decision: reject as the steady-state posture. Use it only if repair receipts become malformed.

### Option C: Serving Promotion Closure And No-Delta Repair Value

The selected path keeps current repair-bid settlement dispatchable, adds a serving promotion closure receipt for source
contracts that are not live yet, and adds no-delta repair accounting for selected lots.

Advantages:

- Preserves zero-notional repair.
- Lets Jangar consume one Torghut receipt for source-to-serving closure.
- Makes repeated repairs accountable.
- Separates high-value selected lots from lower-priority held lots.
- Keeps capital closed while routeability evidence improves.

Disadvantages:

- Adds a payload and tests.
- Requires stable receipt naming for every repair lot.
- May hold repairs that cannot state expected blocker delta.

Decision: select Option C.

## Architecture

Torghut emits `serving_promotion_closure_receipt` beside the repair-bid settlement and, once live, the profit-carry
passport ledger:

```text
serving_promotion_closure_receipt
  schema_version = torghut.serving-promotion-closure-receipt.v1
  receipt_id
  generated_at
  fresh_until
  source_commit
  live_build_commit
  live_image_digest
  active_revision
  required_contracts[]
  live_contracts[]
  missing_live_contracts[]
  closure_decision = current | collecting | hold | block
  reason_codes[]
  jangar_promotion_closure_ledger_ref
```

Torghut also emits `repair_value_accounting_ledger`:

```text
repair_value_accounting_ledger
  schema_version = torghut.repair-value-accounting-ledger.v1
  ledger_id
  generated_at
  fresh_until
  source_repair_bid_settlement_ledger_id
  top_queue_lot_id
  top_queue_lot_class
  selected_lots[]
  no_delta_receipts[]
  value_gate_totals
  max_notional = 0
  capital_decision = repair_only
```

Each selected lot records:

```text
repair_value_lot
  lot_id
  lot_class
  target_value_gate
  expected_output_receipt
  expected_gate_delta
  before_state_ref
  after_state_ref
  decision = dispatchable | held | settled | no_delta | expired
  no_delta_receipt_ref
  max_notional = 0
  reason_codes[]
```

Initial no-delta receipt:

```text
torghut.repair-no-delta-receipt.v1
  receipt_id
  generated_at
  lot_id
  lot_class
  expected_output_receipt
  target_reason_codes[]
  terminal_run_ref
  before_state_ref
  after_state_ref
  no_delta_reason
  recommended_next_state = hold | deprioritize | replace
```

## Policy

- `quant_pipeline` remains the top dispatchable lot while it has priority `100` and no active dedupe key.
- `feature_lineage` and `execution_tca` remain dispatchable only when they name one expected output receipt and
  max notional `0`.
- `rollout_image` and `empirical_replay` remain selected but held when the dispatch limit is reached.
- A selected lot without before and after evidence may run once in observe mode. A repeated run without its receipt
  becomes no-delta debt.
- A no-delta lot cannot block service readiness by itself, but it must lower repair priority before Jangar dispatches
  the same root cause again.
- `profit_carry_passport_ledger` must be present before Torghut claims profit-carry readiness, but its absence does
  not prevent current repair-bid settlement from staying visible as repair-only evidence.
- `max_notional` remains `0` for every lot in this design.

## Implementation Milestones

### Milestone 1: Serving Promotion Closure Receipt

Value gates: `capital_gate_safety`, `ready_status_truth`, `pr_to_rollout_latency`.

- Emit `serving_promotion_closure_receipt` from `/trading/status`, `/readyz`, `/trading/revenue-repair`, and
  `/trading/consumer-evidence`.
- The receipt must compare source commit, live build commit, live image digest, active revision, and required live
  contracts.
- Tests cover source contract present but live contract missing, digest missing, and current live contract.

### Milestone 2: Repair Value Accounting Ledger

Value gates: `zero_notional_or_stale_evidence_rate`, `handoff_evidence_quality`.

- Add `repair_value_accounting_ledger` from the existing repair-bid settlement ledger.
- Publish top queue lot class and id. The current evidence should select `quant_pipeline`.
- Tests prove selected, held, settled, no-delta, and expired lot states.

### Milestone 3: No-Delta Receipt Generation

Value gates: `failed_agentrun_rate`, `manual_intervention_count`.

- Emit `torghut.repair-no-delta-receipt.v1` when a terminal repair run does not produce its expected receipt or does
  not retire the target reason code.
- Feed no-delta receipts into Jangar terminal debt compaction and promotion closure ledger.
- Tests prove repeated no-delta lots lose priority.

### Milestone 4: Profit-Carry Passport Live Closure

Value gates: `routeable_candidate_count`, `post_cost_daily_net_pnl`, `capital_gate_safety`.

- Promote the profit-carry passport ledger to live endpoints.
- Bind each profit-carry passport to the serving promotion closure receipt and Jangar promotion closure ledger.
- Keep all passports zero-notional until a later capital contract graduates.

### Milestone 5: Deployer And Trader Cutover

Value gates: `handoff_evidence_quality`, `manual_intervention_count`.

- Deployer validates serving promotion closure after image promotion.
- Trader review uses no-delta rates before increasing repair budget.
- Record routeable candidate count, no-delta repair count, and selected lot movement before and after rollout.

## Validation Gates

Engineer stage is not complete until:

- endpoint tests prove the serving promotion closure receipt appears on all four live evidence routes;
- tests prove missing `profit_carry_passport_ledger` is a source-to-serving closure hold, not a capital allow;
- tests prove the top queue item is derived from selected repair lots;
- tests prove every repair value lot has one expected output receipt and max notional `0`;
- tests prove no-delta receipts demote repeated repair lots;
- Torghut targeted tests pass for touched reducers;
- Pyright profiles pass for Torghut changes when Python source is touched.

Verify stage is not complete until:

- Argo `torghut`, `torghut-options`, `jangar`, and `agents` are synced and healthy, or exact non-healthy reasons are
  recorded;
- `/db-check` remains schema-current;
- `/readyz` may remain degraded only for capital/profit guards;
- `/trading/revenue-repair` exposes repair value accounting;
- `/trading/consumer-evidence` exposes serving promotion closure;
- Jangar promotion closure ledger consumes the Torghut receipt;
- max notional remains `0`.

## Rollout Plan

1. Emit serving promotion closure receipt in observe mode.
2. Emit repair value accounting from existing repair-bid settlement.
3. Add no-delta receipts and Jangar consumption.
4. Promote profit-carry passport ledger to live endpoints.
5. Enable Jangar to prioritize Torghut repairs by repair value and no-delta state.
6. Keep paper and live capital closed.

## Rollback Plan

Rollback is configuration-first:

- ignore serving promotion closure in Jangar first;
- keep repair-bid settlement as the fallback repair surface;
- keep no-delta receipts for audit if endpoint compatibility is stable;
- do not delete trading rows, AgentRuns, or emitted receipts;
- keep `simple_submit_disabled`, `capital_stage=shadow`, and max notional `0`;
- if endpoint stability regresses, roll back the Torghut serving image.

## Risks And Mitigations

- Risk: no-delta accounting penalizes exploration. Mitigation: no-delta demotes repeated same-root-cause repairs; it
  does not remove evidence or block new hypotheses.
- Risk: source-to-serving closure holds while Argo is green. Mitigation: green Argo is availability evidence, not
  source contract evidence.
- Risk: profit-carry passports are mistaken for capital permission. Mitigation: every receipt and lot carries
  max notional `0`.
- Risk: top queue item hides lower-priority blockers. Mitigation: raw repair bids remain preserved and linked from the
  value ledger.
- Risk: endpoint payload size grows. Mitigation: keep value accounting compact and link to raw settlement ledgers.

## Handoff To Engineer

Implement the serving promotion closure receipt first. It is the smallest production improvement because live evidence
already shows source contracts ahead of the serving payload. Then add repair value accounting and no-delta receipts.

Acceptance gates:

- live endpoints expose source commit, build commit, active revision, and image digest in one receipt;
- missing `profit_carry_passport_ledger` produces a closure hold;
- `quant_pipeline` is the top queue lot while current priority and dispatchability hold;
- no selected lot has non-zero notional;
- no-delta receipts are emitted for repeated terminal lots that do not retire their target reason code.

## Handoff To Deployer

Do not call Torghut revenue-ready because Argo is green or because repair-bid settlement is current. Treat the system
as controlled repair until serving promotion closure is current, repair value accounting is present, and no-delta
receipts show the selected repairs are either moving blockers or losing priority.

Rollout acceptance gates:

- Argo healthy for Torghut and Torghut options;
- `/db-check` schema current;
- `/trading/revenue-repair` reports repair-only with max notional `0`;
- serving promotion closure receipt references the active revision and image digest;
- Jangar promotion closure ledger consumes the Torghut receipt;
- handoff names the blocker retired or the no-delta receipt produced.
