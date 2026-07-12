# 177. Torghut Profit Repair Broker And Capital Promotion Gates (2026-05-08)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

I am selecting a **profit repair broker with capital promotion gates** for Torghut.

Torghut is operationally alive but not capital-ready. On 2026-05-08 at 01:23Z, the live revision `torghut-00291` and
sim revision `torghut-sim-00390` were available. Live `/readyz` showed Postgres, ClickHouse, Alpaca, universe, and
database schema checks as healthy, with expected Alembic head `0029_whitepaper_embedding_dimension_4096`. Live
`/trading/status` showed build `v0.568.5-473-gbce38f6a4`, active revision `torghut-00291`, fresh empirical jobs, and
144 latest quant metrics with about 21 seconds of lag.

That is enough to observe and repair. It is not enough to spend money. The live proof floor was `repair_only`, capital
state was `zero_notional`, simple submit was disabled, no hypotheses were promotion-eligible, two hypotheses required
rollback, the route board had 0 routeable symbols, and average absolute live TCA slippage was about 13.82 bps. The sim
service was ready, but its proof floor was still `repair_only`, with 0 routeable symbols, 7 missing symbols, and about
110.16 bps average absolute TCA slippage. Torghut can improve profitability only by ranking the repairs that buy down
these blockers, then promoting capital in small gates when the evidence closes.

The decision is to add a Torghut profit repair broker that consumes Jangar action broker receipts, route reacquisition
records, proof-floor receipts, quant evidence, alpha readiness, TCA, and market-context receipts. The broker will rank
repair packets by expected unblock value, expected repair cost, and capital impact. It will keep notional at zero until
both the route-local proof and the Jangar upstream action receipt agree that paper or live capital can be promoted.

The tradeoff is slower capital reentry. I accept that because the current failure mode is not missed volume. It is
paying for stale route repair, promoting a hypothesis without enough evidence, or interpreting a healthy dependency as
profitable capital readiness.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Runtime Evidence

- Torghut deployments and Knative revisions were available, including live `torghut-00291` and sim
  `torghut-sim-00390`.
- Torghut namespace events showed repeated `MultiplePodDisruptionBudgets` warnings for ClickHouse pods, a keeper
  PodDisruptionBudget with no pods, and Flink status-update conflicts. These are rollout and availability risks, not
  direct capital approvals.
- Four Torghut quant cron schedules were active and recently scheduled through Agents.
- Jangar action authority was read-only and observe-capable, but material and capital classes were held by missing
  source/GitOps truth and missing controller ingestion self-report.

### Data And Profit Evidence

- Live `/readyz` returned degraded because proof floor was `repair_only`, capital was `zero_notional`, simple submit
  was disabled, and alpha readiness had no promotion-eligible hypotheses.
- Live route evidence covered 8 symbols: 0 routeable, 1 probing (`AAPL`), 4 blocked, and 3 missing. Repair candidates
  included `NVDA`, `AMD`, `INTC`, `AVGO`, `AMZN`, `GOOGL`, and `ORCL`.
- Live TCA had 7334 orders, 7245 filled orders, and average absolute slippage around 13.82 bps, above the live
  guardrail.
- Sim `/readyz` was ok, but the proof floor remained `repair_only`; sim route evidence had 0 routeable, 1 blocked, and
  7 missing symbols.
- Sim TCA had 5 filled orders and average absolute slippage around 110.16 bps, so sim route repair cannot be treated
  as promotion evidence.
- Empirical jobs were fresh and healthy for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`, but current quant stage health still reported missing pipeline-stage proof.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` already fails closed for live submit disabled, no promotion-eligible
  alpha, route universe gaps, stale TCA, slippage breaches, and required quant evidence.
- `services/torghut/app/trading/route_reacquisition.py` and `route_reacquisition_board.py` already produce route state,
  candidate, expected unblock, and repair requirement projections.
- `services/torghut/app/main.py` already exposes proof floor, route reacquisition, TCA, quant evidence, alpha
  readiness, and database schema status through `/readyz` and `/trading/status`.
- The missing contract is a capital-facing broker that discounts repair value when the upstream Jangar action cell is
  not source-settled or capital-ready.

## Problem

Torghut currently has good diagnostic surfaces but no single profit authority. A route can be missing, blocked, or
probing; quant metrics can be fresh; empirical jobs can be healthy; and dependencies can be up. None of those facts by
itself answers whether the next dollar should be spent on provider repair, paper probing, live micro capital, or no
capital at all.

The concrete profitability risks are:

1. Route repair work can be prioritized by recency instead of expected unblock value after cost and upstream evidence.
2. Fresh quant or context evidence can mask the fact that no alpha hypothesis is promotion-eligible.
3. TCA slippage breaches can stay in a diagnostic board instead of vetoing capital promotion.
4. Paper probes can be launched from an unsettled Jangar source/GitOps or controller-ingestion state.
5. Zero-notional repair can be conflated with permission to submit live notional.

Torghut needs one broker that ranks repair for profit and one set of capital gates that convert evidence into allowed
notional.

## Alternatives Considered

### Option A: Continue With The Current Proof Floor And Route Board

Leave the proof floor and route reacquisition board as the capital decision surface.

Advantages:

- No new service code.
- Existing tests already cover many blockers.
- Easy to keep observing current state.

Disadvantages:

- Does not price repair packets against expected profit impact.
- Does not consume Jangar action cells as capital authority.
- Leaves deployers to interpret several diagnostics before deciding paper or live admission.

Decision: keep these surfaces, but make them inputs to a broker.

### Option B: Block All Repair Until Jangar Material Authority Is Fully Ready

Stop Torghut repair work whenever Jangar material action classes are held.

Advantages:

- Very conservative.
- Prevents evidence from unsettled upstream revisions.
- Simple rollback story.

Disadvantages:

- Wastes safe zero-notional repair windows.
- Stops context and TCA evidence collection that can shorten the next paper admission.
- Treats all repair packets as capital risk even when they cannot submit notional.

Decision: reject as the default. Use this only when the broker cannot compute upstream authority.

### Option C: Profit Repair Broker With Capital Gates

Rank repair packets by expected profit impact and gate notional by route-local proof plus Jangar action-cell authority.

Advantages:

- Keeps useful zero-notional repair running.
- Prevents paper and live capital until upstream and route-local proofs converge.
- Gives deployers measurable hypotheses, guardrails, and rollback triggers.
- Turns route repair into a portfolio of expected unblock value instead of a queue of stale failures.

Disadvantages:

- Adds one broker projection and tests.
- Requires consistent Jangar action-cell references in Torghut status.
- Will make some repair packets lower priority even when they are easy to execute.

Decision: select Option C.

## Architecture

Torghut adds a `profit_repair_broker` projection. It is shadow-only at first and consumes existing proof floor,
route reacquisition, TCA, market-context, alpha, quant, empirical, and Jangar action-cell evidence.

```text
profit_repair_packet
  packet_id
  symbol
  account_label
  repair_class                 # route_tca | market_context | alpha_feature | drift_check | quant_stage | submit_gate
  current_state                # missing | blocked | probing | repairable | paper_candidate | live_candidate
  jangar_action_cell_ref
  jangar_action_decision
  proof_floor_ref
  route_receipt_ref
  tca_receipt_ref
  alpha_readiness_ref
  quant_stage_ref
  expected_unblock_value
  expected_repair_cost
  expected_profit_effect_bps
  capital_notional_limit
  guardrail_failures
  rollback_target
```

Promotion gates:

- `observe`: allowed when dependencies and Jangar observe/read-only cells are healthy enough to read.
- `zero_notional_repair`: allowed when the packet cannot submit capital and Jangar allows `torghut_observe` or
  `dispatch_repair`.
- `paper_probe`: requires Jangar `paper_canary` cell allowed, no route universe empty/incomplete blocker for the
  symbol, sample count above the paper minimum, no alpha rollback requirement, and paper slippage below guardrail.
- `live_micro`: requires Jangar `live_micro_canary` cell allowed, paper settlement, live submit explicitly enabled,
  live slippage below guardrail, and a broker notional cap.
- `live_scale`: requires Jangar `live_scale` cell allowed, multiple settled live micro windows, no quant stage missing
  proof, and no active rollback-required hypothesis.

Repair priority:

```text
net_repair_priority =
  expected_unblock_value
  - expected_repair_cost
  + expected_profit_effect_bps
  - upstream_authority_discount
  - guardrail_penalty
```

The broker should expose both the ranked packet list and the reason a packet cannot advance. That gives the engineer a
build target, the deployer a rollout gate, and the trading owner a concrete profitability hypothesis.

## Measurable Hypotheses And Guardrails

Hypotheses:

- Route-universe repair improves the routeable-symbol count from 0 to at least 3 before any live micro canary.
- TCA repair reduces average absolute live slippage below 8 bps for paper promotion and below 12 bps for live micro.
- Feature and drift repair moves at least one hypothesis from shadow to paper-eligible without rollback-required
  status.
- Quant-stage proof closes `quant_pipeline_stages_missing` before live scale.
- Jangar action-cell authority closes missing source/GitOps and controller ingestion blockers before paper capital.

Guardrails:

- `capital_notional_limit=0` while proof floor is `repair_only`.
- No paper probe when route universe is empty or the symbol has missing TCA/context receipts.
- No live micro when simple submit is disabled, average absolute slippage exceeds guardrail, or alpha rollback is
  required.
- No live scale without paper settlement, live micro settlement, and Jangar `live_scale` authority.
- Any broker computation failure fails closed to zero notional and preserves observe-only status.

## Implementation Scope

Engineer stage:

- Add a pure profit repair broker reducer that consumes existing proof-floor and route-board payloads plus a Jangar
  action-cell summary.
- Expose broker output from `/readyz` and `/trading/status` in shadow mode.
- Add tests for live submit disabled, slippage guardrail breach, route universe empty/incomplete, missing Jangar action
  cell, zero-notional repair allowed, paper blocked, live micro blocked, and repair priority ordering.
- Keep existing proof-floor behavior authoritative until broker output matches it over at least one cron cycle.

Deployer stage:

- Wire Torghut to read the Jangar action broker status from the in-cluster Jangar service.
- Keep capital notional at zero unless the broker emits a positive paper or live cell and the corresponding Jangar
  action cell is allowed.
- Add rollout checks for ClickHouse PDB warnings and keeper PDB coverage before widening Torghut capital.
- Record paper and live promotion decisions with broker packet IDs, not free-form notes.

## Validation Gates

Local validation:

- `uv run --frozen pytest services/torghut/tests/test_profitability_proof_floor.py`
- Add `services/torghut/tests/test_profit_repair_broker.py` covering every promotion gate and priority calculation.
- Existing route reacquisition, market context, and readiness tests stay green.

Live validation:

- Live `/readyz` and `/trading/status` expose `profit_repair_broker.mode=shadow`.
- Broker packets rank route repair by expected unblock value after cost and upstream authority discount.
- Zero-notional repair stays allowed while `paper_probe`, `live_micro`, and `live_scale` stay blocked under current
  proof-floor evidence.
- At least one paper candidate appears only after route receipts, alpha readiness, slippage, quant-stage proof, and
  Jangar `paper_canary` authority converge.
- No live notional is submitted while simple submit is disabled or broker notional cap is zero.

## Rollout

1. Ship broker status in shadow mode.
2. Compare broker capital gates with proof-floor decisions for one full Torghut quant cron cycle.
3. Enable broker ranking for zero-notional repair ordering.
4. Enable paper probe admission only after route count, TCA, alpha, quant, and Jangar paper authority gates pass.
5. Enable live micro and live scale only after paper settlement and explicit deployer approval.

## Rollback

- Disable broker enforcement and keep proof floor as the capital authority.
- Keep `/readyz` and `/trading/status` publishing broker shadow output for diagnosis if the reducer is healthy.
- Force `capital_notional_limit=0` on missing Jangar action cells, missing route receipts, slippage breaches, alpha
  rollback, quant-stage proof gaps, or broker errors.
- Revert repair ordering to the current route reacquisition board if broker priority calculation is wrong.

## Risks And Open Questions

- Current direct SQL assessment is blocked by RBAC, so the broker should initially trust application schema
  projections and expose the missing direct-read evidence as a deployer task.
- Route repair expected value needs calibration. The first release should be rank-order only, not a dollar forecast.
- ClickHouse and keeper PDB warnings are not capital blockers today, but they are rollout-risk evidence that should be
  visible before widening.
- Jangar action-cell fetch failures must fail closed for capital and fail open only for observe when local dependencies
  are readable.

## Handoff Contract

Engineer acceptance gates:

- Broker reducer and tests cover every promotion gate and at least one priority-ordering case.
- Torghut status surfaces broker packets with Jangar action-cell references.
- Zero-notional repair remains possible while paper/live notional is blocked by current evidence.

Deployer acceptance gates:

- Jangar action broker cells are available to Torghut before paper admission.
- Paper promotion requires broker packet ID, proof-floor receipt, route receipt, alpha readiness receipt, and Jangar
  `paper_canary` allowance.
- Live micro and live scale remain disabled until simple submit is explicitly enabled and broker notional caps are
  non-zero.
