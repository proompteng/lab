# 198. Torghut Alpha Repair Closure Board And Routeable Revenue Reentry (2026-05-14)

Status: Accepted for Jangar engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

I am selecting an **alpha repair closure board** as Torghut's companion contract for Jangar's cross-plane closure
board.

The live business surface is still repair-only. On 2026-05-14, `GET /trading/revenue-repair` returned
`revenue_ready=false`, `business_state=repair_only`, and top queue item `repair_alpha_readiness`. The top item targets
`routeable_candidate_count`, has reason `hypothesis_not_promotion_eligible`, expected unblock value `4`, max
notional `0`, capital rule `zero_notional_repair_only`, and required output receipt
`torghut.executable-alpha-receipts.v1`.

The broader readiness picture is capital-safe but not revenue-ready. `GET /db-check` returned schema-current at
`0031_autoresearch_candidate_spec_epoch_uniqueness`. `GET /readyz` returned HTTP 503 with `status=degraded`, while
Postgres, ClickHouse, Alpaca, database schema, universe, readiness cache, empirical jobs, DSPy runtime, and optional
quant evidence were healthy. The live submission gate was blocked by `simple_submit_disabled`; profitability proof
floor was `repair_only`; capital state was zero-notional; active capital stage was shadow.

The selected contract gives Torghut one compact board that Jangar can read without parsing the full readiness payload.
It ranks the alpha-readiness blocker, names the required executable-alpha receipt, states the before/after evidence,
and records no-delta outcomes so the same repair does not consume repeated runner slots without changing the blocker
set.

The tradeoff is stricter accounting. A repair that produces no routeable-candidate movement becomes no-delta debt even
if the code change was useful. I accept that because the business goal is revenue repair, not unbounded evidence churn.

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
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Current Evidence

All evidence was collected read-only on 2026-05-14.

### Business Surface

- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned `revenue_ready=false` and
  `business_state=repair_only`.
- The top queue item was:
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
- Jangar `/ready` saw Torghut consumer evidence `current`, decision `repair`, route repair value `14`,
  profit-repair state `repair`, routeability state `blocked`, and three dispatchable compacted lots.
- Jangar's parsed blockers included stale execution TCA, missing active session samples, non-positive post-cost
  expectancy, missing drift checks, feature rows missing, required feature set unavailable, and alpha readiness not
  promotion eligible.

### Runtime And Cluster

- Argo settled to `torghut=Synced/Healthy` at revision `16d4cac22ddd6c29f219f42273597143ad36156e`.
- The active Torghut live pod was `torghut-00370-deployment-b7bc4c75b-d9txw`, `2/2 Running`.
- The active Torghut sim pod was `torghut-sim-00468-deployment-c6589db54-b5b4v`, `2/2 Running`.
- Torghut DB, ClickHouse, Keeper, options catalog, options enricher, TA, TA sim, WebSocket, and guardrail exporters
  were running.
- Whitepaper autoresearch profit-target pods had a long error tail while one current pod was running. That is not the
  current revenue-repair blocker, but it reinforces the need for no-delta repair accounting.
- Torghut quant AgentRuns since `2026-05-13T00:00:00Z` had `41` Succeeded, `2` Failed, and `2` Running; both failed
  runs timed out in verify.

### Database And Data Quality

- Direct CNPG object reads were forbidden for this service account, and pod exec was forbidden. The accepted evidence
  path is Torghut's application-level database witness.
- `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, and account scope ready.
- Schema lineage was ready with known parent-fork warnings for historical migration branches under
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/readyz` dependencies showed Postgres, ClickHouse, Alpaca, database schema, universe, readiness cache, empirical
  jobs, DSPy runtime, and quant evidence as optional all healthy or acceptable.
- Live submission remained blocked by `simple_submit_disabled`.
- Profitability proof floor remained `repair_only`.
- Capital state remained `zero_notional`, and active capital stage remained `shadow`.
- The live gate evaluated hypotheses in shadow state; routeable candidate admission remains blocked until alpha
  readiness, promotion custody, feature lineage, and post-cost proof move.

## Problem

Torghut now names the business blocker, but the repair evidence is still spread across several payloads and old
selected-lot priority can obscure the top queue item.

The concrete failure modes are:

1. Jangar can spend runner capacity on generic repair lots while `/trading/revenue-repair` says alpha readiness is the
   top blocker.
2. A repair attempt can finish without proving that `routeable_candidate_count` moved.
3. The same no-delta alpha repair can be launched repeatedly if the blocker set and evidence window do not change.
4. `/readyz` is correctly degraded, but it is too large for admission. Jangar needs a compact repair closure board.
5. Source-to-serving mismatch and manifest digest debt can hide whether the alpha repair contract is live.
6. Capital must stay zero-notional even when repair work is admitted.

The architecture must make routeable revenue reentry measurable without relaxing capital safety.

## Alternatives Considered

### Option A: Use The Existing Revenue Repair Queue As-Is

Torghut keeps publishing `/trading/revenue-repair`; Jangar continues to infer runnable work from the top queue item and
repair-bid settlement.

Advantages:

- No new payload.
- Maintains the existing business surface.
- Low implementation cost.

Disadvantages:

- The queue item is not an outcome receipt.
- No-delta repeats are not explicit.
- Jangar still has to parse long readiness and consumer-evidence payloads.
- Source-to-serving closure remains implicit.

Decision: reject as the next architecture. The queue remains the governing evidence surface, but it needs closure
receipts.

### Option B: Freeze All Torghut Repair Until `/readyz` Is Healthy

Torghut blocks repair admission until live readiness is green.

Advantages:

- Very safe for capital.
- Easy to explain during an incident.
- Avoids dispatching while source and readiness are split.

Disadvantages:

- Deadlocks the repair path because `/readyz` needs alpha repair to become green.
- Increases manual intervention.
- Does not improve `routeable_candidate_count`.

Decision: reject. Capital stays closed, but zero-notional repair must remain possible.

### Option C: Alpha Repair Closure Board

The selected option publishes a compact board that ranks the alpha-readiness queue item, names the expected output
receipt, and records before/after or no-delta outcomes.

Advantages:

- Gives Jangar one small object for admission.
- Keeps live submission disabled and max notional zero.
- Aligns runner capacity with the current revenue-repair top item.
- Makes repeated no-delta repair launches visible and deniable.
- Preserves `/trading/revenue-repair` as the live business evidence surface.

Disadvantages:

- Adds another contract and tests.
- Requires stable linkage between queue item, repair lot, after receipt, and Jangar board id.
- Can delay lower-priority repair lots while alpha readiness is first.

Decision: select Option C.

## Architecture

Torghut publishes `alpha_repair_closure_board` on `/trading/revenue-repair`, `/trading/consumer-evidence`, and
`/readyz` as an additive compact object.

```text
alpha_repair_closure_board
  schema_version = torghut.alpha-repair-closure-board.v1
  board_id
  generated_at
  fresh_until
  account
  window
  business_state = repair_only | ready
  revenue_ready
  top_queue_item_ref
  selected_value_gate
  routeable_candidate_count
  max_notional
  capital_rule
  source_serving_closure_ref
  repair_closures[]
  no_delta_debt[]
  jangar_cross_plane_closure_board_ref
```

Each `repair_closure` carries:

```text
repair_closure
  closure_id
  queue_code
  reason_code
  value_gate
  priority
  expected_unblock_value
  required_output_receipt
  required_receipts[]
  before_refs[]
  after_refs[]
  measured_delta
  no_delta_reason
  validation_commands[]
  dedupe_key
  max_notional = 0
  capital_rule = zero_notional_repair_only
  rollback_target
```

Admission rules:

1. The board is current only if generated within its TTL and `/db-check` schema is current.
2. The top queue item must remain `repair_alpha_readiness` before Jangar gives it reserved repair capacity.
3. `max_notional` must be `0`, live submission must remain disabled, and capital stage must remain shadow.
4. A repair can graduate only by producing `torghut.executable-alpha-receipts.v1` and at least one required after
   receipt.
5. A terminal repair with no blocker change emits no-delta debt with the dedupe key and may not be relaunched until
   the evidence window, blocker set, source ref, or required receipt changes.
6. Paper and live capital stay blocked until separate proof-floor, TCA, routeability, and capital safety gates pass.

## Implementation Scope

M1: Add a pure Torghut `build_alpha_repair_closure_board` helper.

- Inputs: revenue repair digest, executable alpha receipts, capital replay projection, db-check result, and source
  serving metadata.
- Output: board schema above.
- Tests: top item is alpha readiness, zero-notional capital rule, no-delta debt, stale board, required receipt mapping.
- Value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, `capital_gate_safety`.

M2: Add the board to `/trading/revenue-repair` only.

- Keep payload additive.
- Do not change `/readyz` status or live submission.
- Tests: existing revenue-repair clients continue to parse.
- Value gates: `ready_status_truth`, `handoff_evidence_quality`.

M3: Add compact board refs to `/trading/consumer-evidence` and `/readyz`.

- Include board id, top closure id, selected value gate, required output receipt, and no-delta count.
- Tests: Jangar consumer evidence parser accepts the compact board.
- Value gates: `manual_intervention_count`, `ready_status_truth`.

M4: Let Jangar reserve one zero-notional repair slot only when the board is current and top-ranked.

- This is implemented in the companion Jangar design.
- Tests: stale board or nonzero notional blocks admission.
- Value gates: `failed_agentrun_rate`, `manual_intervention_count`.

## Validation Gates

Architecture PR validation:

- `bunx oxfmt --check docs/agents/designs/193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md docs/torghut/design-system/v6/198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md docs/agents/release-handoffs/jangar-control-plane-cross-plane-closure-board-2026-05-14.md docs/agents/README.md docs/torghut/design-system/v6/index.md`

Engineer implementation validation:

- `pytest services/torghut/tests/test_revenue_repair.py -k alpha_repair_closure_board`
- `pytest services/torghut/tests/test_executable_alpha_receipts.py -k closure`
- `pytest services/torghut/tests/test_trading_api.py -k revenue_repair`
- `ruff check services/torghut/app/trading services/torghut/tests`

Deployer validation:

- Argo `torghut` and `agents` `Synced/Healthy`.
- Torghut live and sim Knative revisions ready.
- `GET /db-check` schema current.
- `GET /trading/revenue-repair` includes `alpha_repair_closure_board`.
- `GET /readyz` may remain HTTP 503 while live submission and proof floor are blocked; that is expected.
- Jangar status references the Torghut board without admitting nonzero notional.

## Rollout

Phase 0 merges this design and the Jangar companion.

Phase 1 adds the pure board builder and tests with no API exposure.

Phase 2 exposes the board on `/trading/revenue-repair`.

Phase 3 adds compact refs to consumer evidence and readiness.

Phase 4 lets Jangar use the board for one zero-notional reserved repair slot.

No phase enables paper or live capital. Those gates remain independent.

## Rollback

Rollback is additive and configuration-first:

- remove or disable board emission from `/trading/revenue-repair`;
- keep the existing revenue repair digest, repair-bid settlement, executable alpha receipts, and capital replay board;
- keep live submission disabled and max notional `0`;
- keep Jangar fallback on existing Torghut consumer evidence and repair-bid settlement;
- do not delete repair receipts, AgentRuns, jobs, or database rows.

## Risks

- Board drift from revenue repair queue: use the queue digest and board digest in tests and status.
- No-delta overblocking: allow relaunch when source, evidence window, or blocker set changes.
- Payload size growth: publish compact refs in `/readyz`; keep full board on `/trading/revenue-repair`.
- False capital confidence: hard-code max notional `0` and live submit disabled as required conditions.
- Source-serving mismatch: include source build and serving revision refs, but let Jangar own the cross-plane closure
  decision.

## Handoff

Engineer: start with the pure builder and tests. Do not change live submission, capital settings, or route admission in
the first PR.

Deployer: a successful rollout proves the board is visible and capital remains closed. It does not prove Torghut is
revenue-ready.

Smallest implementation milestone: publish a tested `alpha_repair_closure_board` on `/trading/revenue-repair` with
top closure `repair_alpha_readiness`, required output `torghut.executable-alpha-receipts.v1`, max notional `0`, and
no-delta debt semantics.
