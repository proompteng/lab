# 196. Jangar Alpha Closure Slot Governor And No-Delta Budget (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar repair admission, Torghut alpha closure settlement, no-delta retry budget, runner slot custody, source
and rollout proof, validation, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`

Extends:

- `193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md`
- `192-jangar-alpha-readiness-repair-escrow-and-runner-admission-2026-05-13.md`
- `192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md`
- `188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md`
- `186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`

## Decision

I am selecting an **alpha closure slot governor with a no-delta budget** for Jangar's next Torghut repair admission
contract.

The live Jangar surface is healthy enough to govern, but not safe enough to launch material trading actions. On
2026-05-14 at 00:27 UTC, `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, leader election was
active, and execution trust was healthy. Jangar observed Torghut consumer evidence as current, serving revision
`torghut-00371`, build commit `8d84f9f5ce028214bfb5326e0791638bc35625f5`, decision `repair`, route repair value `14`,
and accepted routeable candidate count `0`.

That healthy control-plane posture should not become broad runner admission. The Torghut business surface still says
`repair_only`; live submit is disabled; max notional is zero; and `/readyz` is degraded for the correct reasons.
Jangar sees three dispatchable Torghut repair lots today: `quant_pipeline`, `promotion_custody`, and
`feature_lineage`. The selected Jangar behavior is to reserve exactly one zero-notional alpha closure slot when
Torghut's `alpha_repair_closure_board` is current, the selected market targets `routeable_candidate_count`, and no
active no-delta debt blocks the dedupe key.

The first closure target is the Torghut-selected `H-MICRO-01` feature replay market. Jangar should not decide the
hypothesis by itself; it should verify the Torghut board, enforce slot and no-delta rules, and attach launch evidence
to the resulting AgentRun or handoff. If the closure produces no movement, the no-delta budget denies repeats until the
evidence key changes.

The tradeoff is lower launch volume. I accept that. The current failure tail includes failed and timed-out AgentRuns
across Jangar and Torghut lanes. More runner starts will not improve profitability if the starts are not tied to the
top revenue repair item and a terminal outcome receipt.

## Governing Runtime Requirements

This contract implements the active validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Jangar value gates:

- `failed_agentrun_rate`: deny duplicate no-delta alpha closure launches and stale board launches.
- `pr_to_rollout_latency`: require the deployer to cite source, image, Argo, workload, service, and Torghut board
  evidence before calling a rollout complete.
- `ready_status_truth`: keep `/ready=ok` separate from material-action readiness.
- `manual_intervention_count`: turn the broad Torghut repair surface into one current closure slot.
- `handoff_evidence_quality`: require board id, market id, selected hypothesis, required receipt, validation command,
  and rollback target in every handoff.

Torghut value gates carried through Jangar admission:

- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `post_cost_daily_net_pnl`
- `capital_gate_safety`

## Current Evidence

Evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading flags,
GitOps resources, AgentRuns, or market data.

### Cluster And Runtime

- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Jangar `/ready` returned `status=ok`, leader election enabled, current pod leader true, and execution trust healthy.
- Torghut live and sim serving pods were running as `torghut-00371` and `torghut-sim-00469`.
- Torghut core data plane pods were running: Postgres, ClickHouse, Keeper, TA, TA sim, options services, WebSocket
  services, and guardrail exporters.
- Recent cluster events still show workload noise: failed whitepaper autoresearch pods, failed market-context jobs, and
  failed or timed-out Jangar/Torghut AgentRun pods. This is the failure class the no-delta budget is intended to
  reduce.

### Jangar Torghut Evidence

- Torghut consumer evidence status was `current`.
- Serving revision was `torghut-00371`; build commit was `8d84f9f5ce028214bfb5326e0791638bc35625f5`.
- Decision was `repair`; route repair value was `14`; accepted routeable candidate count was `0`.
- Observed Torghut contracts included route warrant exchange, repair-bid settlement, repair outcome dividend, source
  serving repair receipt, freshness carry, routeability repair acceptance, profit repair settlement, routeable profit
  candidate exchange, and alpha readiness strike ledger.
- Repair-bid settlement exposed these compacted lots:
  - `quant_pipeline`, priority `100`, dispatchable, required receipt `torghut.quant-pipeline-current-receipt.v1`;
  - `promotion_custody`, priority `98`, dispatchable, required receipt `torghut.executable-alpha-receipts.v1`;
  - `feature_lineage`, priority `95`, dispatchable, required receipt `torghut.feature-lineage-current-receipt.v1`;
  - `execution_tca`, priority `90`, held by `dispatch_limit_exceeded`;
  - `rollout_image`, priority `80`, held by `dispatch_limit_exceeded`;
  - `empirical_replay`, priority `70`, held by `selection_limit_exceeded`.
- Evidence clock state was `split`; blocking reasons included `hypothesis_not_promotion_eligible`,
  `drift_checks_missing`, `feature_rows_missing`, `required_feature_set_unavailable`,
  `execution_tca_slippage_guardrail_exceeded`, `execution_tca_symbol_missing`, `simple_submit_disabled`, and
  `max_notional_zero`.

### Torghut Business Evidence

- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, and active revision
  `torghut-00371`.
- Capital stayed closed: `live_submission_allowed=false`, `capital_stage=shadow`, `capital_state=zero_notional`, and
  `max_notional=0`.
- The top queue item was `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, selected gate
  `routeable_candidate_count`, expected unblock value `4`, required receipt `torghut.executable-alpha-receipts.v1`.
- `/db-check` was schema-current at `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `/readyz` was degraded because `simple_submit_disabled` and proof-floor `repair_only` were true. Postgres,
  ClickHouse, Alpaca, database schema, universe, and empirical jobs were healthy.

## Problem

Jangar can now see too much, not too little. It has current Torghut evidence, dispatchable lots, source and rollout
proof, execution trust, and ready truth. Without a specific slot governor, it can still spend capacity in the wrong
order or repeat an unchanged alpha repair.

The concrete failure modes are:

1. `/ready=ok` can be misread as permission for broad material work.
2. Three repair lots are dispatchable, but only one is tied to the top revenue queue item.
3. Torghut's prior closure board design is not implemented, so Jangar cannot yet cite a compact board id.
4. Failed or timed-out AgentRuns can repeat without proving the source or blocker set changed.
5. A no-delta alpha repair can preserve every blocker and still consume a future slot.
6. Deployer handoffs can pass with rollout health while the business lane remains `routeable_candidate_count=0`.

Jangar needs to act as the slot governor, not the strategy chooser. Torghut selects the market. Jangar verifies that
the market is current, zero-notional, and not duplicate debt.

## Alternatives Considered

### Option A: Admit Any Dispatchable Torghut Repair Lot

Jangar launches work whenever repair-bid settlement reports a dispatchable lot and capital is zero.

Advantages:

- Simple and fast.
- Uses existing fields already parsed by Jangar.
- Keeps quant, promotion, and feature work moving.

Disadvantages:

- It ignores the top revenue queue item when multiple lots are dispatchable.
- It does not enforce a no-delta cooldown.
- It can raise failed AgentRun rate by launching stale or duplicate work.
- It does not improve ready-status truth because `/ready=ok` remains too broad.

Decision: reject. Dispatchable is necessary but not sufficient.

### Option B: Freeze Torghut Repair Until The Full Cross-Plane Closure Board Exists

Jangar denies Torghut repair slots until both `cross_plane_closure_board` and `alpha_repair_closure_board` are fully
implemented and mirrored.

Advantages:

- Very conservative.
- Reduces accidental launches against incomplete contracts.
- Easy to explain during rollout.

Disadvantages:

- It blocks the zero-notional repair work needed to create those contracts.
- It increases manual intervention.
- It leaves the current routeable-candidate blocker unchanged.

Decision: reject as the steady path. Use this only as an emergency stop if capital safety preconditions fail.

### Option C: Alpha Closure Slot Governor

Jangar admits one zero-notional Torghut alpha closure slot only when Torghut publishes a current closure board and the
dedupe key is not under no-delta debt.

Advantages:

- Keeps Torghut strategy selection inside Torghut.
- Ties runner capacity to the live revenue queue.
- Denies stale boards, nonzero notional, and duplicate no-delta attempts.
- Reduces failed and timed-out AgentRuns by requiring one closure target and one receipt.
- Gives deployer handoff one board id and one market id to cite.

Disadvantages:

- Adds a new admission reducer and tests.
- Holds some useful repairs until the selected closure settles.
- Requires Torghut to publish the board before enforcement mode can be enabled.

Decision: select Option C.

## Architecture

Jangar consumes a compact `alpha_repair_closure_board_ref` from Torghut consumer evidence. Until that field exists,
Jangar remains in observe mode and continues to parse repair-bid settlement and alpha readiness strike ledger.

```text
jangar.alpha-closure-slot-governor.v1
  governor_id
  generated_at
  fresh_until
  mode = observe | shadow | enforce
  torghut_consumer_evidence_ref
  torghut_alpha_repair_closure_board_ref
  selected_market_id
  selected_hypothesis_id
  selected_value_gate = routeable_candidate_count
  required_output_receipt
  no_delta_budget_ref
  admission_decision = allow | hold | deny
  denied_reason_codes[]
  launch_ticket
  stop_conditions[]
  rollback_target
```

Admission allows only when all conditions pass:

1. Torghut consumer evidence is current.
2. The alpha closure board is current and schema-valid.
3. Selected value gate is `routeable_candidate_count`.
4. The selected market has `max_notional=0`.
5. Live submission is disabled and capital stage is shadow.
6. No active no-delta debt exists for the selected dedupe key.
7. Required output receipt is one of the approved zero-notional receipts.
8. The action class is `dispatch_repair`; paper and live action classes remain held.

Admission denies when any of these reason codes appear:

- `torghut_alpha_closure_board_missing`
- `torghut_alpha_closure_board_stale`
- `torghut_alpha_closure_not_zero_notional`
- `torghut_alpha_closure_gate_not_routeable_candidate_count`
- `alpha_closure_no_delta_budget_exhausted`
- `live_submission_not_disabled`
- `capital_stage_not_shadow`
- `required_output_receipt_unapproved`

No-delta budget:

```text
no_delta_budget
  key = account_id + window + hypothesis_id + repair_class + source_commit + blocker_digest
  max_attempts_per_key = 1
  expires_when_any_changes = source_commit | evidence_window | blocker_digest | required_receipt_set
  terminal_receipt_required = torghut.alpha-closure-settlement-receipt.v1
```

Launch ticket:

```text
launch_ticket
  action_class = dispatch_repair
  max_parallelism = 1
  max_runtime_seconds = 1200
  branch_prefix = codex/swarm-torghut-quant-implement
  required_prompt_refs[]
  required_validation_commands[]
  required_handoff_fields[]
```

## Implementation Scope

M1: Extend Jangar's Torghut consumer-evidence parser with optional alpha closure compact refs.

- Accept missing fields in observe mode.
- Validate schema, freshness, selected gate, notional, and required receipt when present.
- Tests: parser accepts current board, denies stale board, denies nonzero notional.

M2: Add the pure slot-governor reducer.

- Inputs: Torghut consumer evidence, no-delta debt records, ready truth, execution trust, and current time.
- Output: `jangar.alpha-closure-slot-governor.v1`.
- Tests: allow one current zero-notional closure; deny duplicate no-delta; deny paper/live action classes.

M3: Surface the governor in control-plane status.

- Include governor id, selected market id, selected hypothesis id, required receipt, and denied reason codes.
- Keep `/ready=ok` serving behavior unchanged.

M4: Enforce for Torghut repair dispatch.

- Start in observe, then shadow, then enforce.
- Enforce only for alpha closure slots; do not change merge, deploy, or non-Torghut admission behavior in this PR.

M5: Deployer proof.

- Deployer must prove Jangar sees the board and governor, Torghut still has max notional zero, and the service remains
  healthy or correctly degraded.

## Validation Gates

Architecture PR validation:

- `bunx oxfmt --check docs/agents/designs/196-jangar-alpha-closure-slot-governor-and-no-delta-budget-2026-05-14.md docs/torghut/design-system/v6/201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md docs/agents/release-handoffs/torghut-alpha-closure-settlement-2026-05-14.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `git diff --check`

Engineer validation:

- `bun run --filter jangar test -- src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-repair-bid-admission.test.ts`
- `bun run --filter jangar test -- src/server/__tests__/control-plane-status.test.ts -t alpha`
- `bunx oxfmt --check services/jangar/src/server services/jangar/src/server/__tests__`
- Torghut companion checks from the companion doc must pass if the PR spans both services.

Deployer validation:

- `GET http://agents.agents.svc.cluster.local/ready` stays `status=ok`.
- Jangar control-plane status includes the slot governor in observe or shadow mode before enforcement.
- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` includes the Torghut closure board.
- `GET http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` includes compact board refs.
- Torghut `/readyz` may remain HTTP 503 for `simple_submit_disabled` and proof-floor `repair_only`.
- No deployer may claim routeable revenue readiness until `routeable_candidate_count > 0` or the smallest blocker is
  named.

## Rollout

Phase 0 merges this design and the Torghut companion.

Phase 1 adds parser support in observe mode.

Phase 2 adds the pure slot-governor reducer and status output in shadow mode.

Phase 3 connects dispatch admission for one alpha closure slot.

Phase 4 enables enforcement only after Torghut emits closure board refs and no-delta debt is visible.

Phase 5 evaluates the first closure. If the terminal receipt is no-delta, the same key is denied until source or
evidence changes. If it improves routeable-candidate evidence, the next slot can move to TCA or post-cost replay.

## Rollback

Rollback is configuration-first:

- set the slot governor mode to `observe`;
- ignore alpha closure compact refs and use existing repair-bid admission;
- preserve no-delta records for audit but do not enforce them;
- keep ready truth, source-serving verdicts, repair-bid admission, and Torghut consumer evidence unchanged;
- do not delete AgentRuns, database records, receipts, or trading evidence.

## Risks

- Enforcement before Torghut emits a board can freeze useful repair. Keep observe mode as the default until board
  visibility is proven.
- A no-delta denial can block a legitimate retry. The key must include source commit, evidence window, blocker digest,
  and required receipt set.
- The governor can become another broad status object. Keep it compact: one selected market, one decision, one denied
  reason list.
- The first feature replay may not improve post-cost PnL. That is acceptable only if the terminal receipt preserves
  the post-cost blocker and keeps capital closed.
- The failure tail in the agents namespace includes old retained pods. Use current service status and fresh receipts
  for admission, not retained pod count alone.

## Handoff

Engineer: implement parser support and the pure governor before enforcement. Do not launch AgentRuns from the reducer
itself. Do not open paper or live action classes. The first enforcement target is one zero-notional alpha closure slot
selected by Torghut, not a generic repair queue item.

Deployer: prove Jangar can see the governor and Torghut closure board after rollout. The rollout is successful if the
governor is visible, Torghut remains capital-closed, and stale or duplicate alpha closures are denied in shadow or
enforce mode.

Control-plane metric improved: `failed_agentrun_rate` should fall by denying stale or duplicate no-delta alpha closure
launches. If it does not move, the smallest blocker is missing Torghut `alpha_repair_closure_board` emission.
