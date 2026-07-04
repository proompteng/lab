# 158. Torghut Capital Proof Provenance And Routeable Edge Repair Ledger (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut capital proof provenance, routeable edge repair, Jangar source provenance consumption, profit
hypotheses, validation, rollout, rollback, and implementation handoff.

Companion Jangar contract:

- `docs/agents/designs/154-jangar-source-provenance-leases-and-material-action-escrow-2026-05-07.md`

Extends:

- `157-torghut-profit-contract-actuation-and-capital-surface-truth-2026-05-07.md`
- `156-torghut-repair-closure-yield-ledger-and-capital-unlock-receipts-2026-05-07.md`
- `152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`

## Decision

I am selecting capital proof provenance with a routeable edge repair ledger as the next Torghut profitability
architecture step.

Torghut is not down. It is refusing capital. Live `/readyz` is degraded, but the live dependencies are healthy, the
database schema is current, and the proof floor is doing the right thing by keeping capital at zero notional. The live
blocker that matters most has shifted from broad TCA slippage to routeability: the active live account has zero
routeable symbols, five blocked symbols, three missing symbols, stale market context, no promotion-eligible alpha, and
live submission disabled. Simulation is HTTP `200`, but it is also repair-only and zero-notional.

The next profitable move is not to loosen the proof floor. It is to prove which repairs create a routeable, post-cost
edge surface and to bind that proof to Jangar source provenance before any capital surface consumes it. Torghut should
publish a `CapitalProofProvenanceReceipt` for each paper or live capital candidate and a `RouteableEdgeRepairRecord`
for every repair that changes symbol routeability, TCA, market context, alpha readiness, or quant ingestion state.

The tradeoff is strict capital patience. A single routeable simulation symbol or fresh live metric is not enough. The
system earns paper and live notional only when routeability, freshness, source provenance, and contract actuation are
all current for the same hypothesis window.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `capital_proof_provenance` and `routeable_edge_repair_ledger` from `/readyz`,
  `/trading/health`, and `/trading/status`.
- Live capital remains `zero_notional` when routeable live symbol count is zero.
- Paper canary requires scoped routeability, fresh market context, alpha readiness, and Jangar source provenance.
- Live micro canary requires live routeable symbols, passing TCA for the scoped symbols, live submission policy, and
  Jangar material action escrow.
- A repair record measures before/after routeable symbols, blocked symbols, missing symbols, TCA, market context,
  quant lag, and alpha readiness.
- Capital receipts cannot cite Jangar contracts that are absent, design-only, or expired.
- Observation and zero-notional repair continue when service dependencies are healthy enough to measure.
- Deployer gates can reject capital with one receipt ID and one reason list.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Runtime And Cluster Evidence

- `torghut` active live and simulation revisions were `torghut-00271` and `torghut-sim-00371`, both available at
  `1/1`.
- Both active revisions used image digest `sha256:a11681083f23a9e0b9255b4e7e5052d812708514c965860a95b70e55958dad34`.
- Torghut Postgres, ClickHouse, Keeper, options catalog, options enricher, TA, TA simulation, options TA, WebSocket
  services, Symphony, Alloy, and guardrail exporters were running.
- A retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod was in `Error`.
- Recent Torghut events showed revision rollouts, DB migrations, whitepaper/empirical backfill jobs completing,
  transient readiness failures for options services, duplicate ClickHouse PodDisruptionBudget warnings, and Flink
  status-modified-externally warnings.
- The service account could read deployments, pods, services, and events, but could not list Knative service resources
  in the Torghut namespace.

### Live Capital And Data Evidence

- Live `/readyz` returned HTTP `503` with `status=degraded`.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca live account `PA3SX7FYNUTF`, Jangar universe,
  readiness cache, empirical jobs, DSPy non-live mode, and database schema.
- Live schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage had one branch, no duplicate revisions, no orphan parents, and known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live execution TCA had 7334 orders, 7245 filled executions, latest TCA at `2026-05-07T14:23:43.480686+00:00`,
  average absolute slippage `13.8203637593029676` bps, and guardrail `8` bps.
- Live symbol routing showed zero routeable symbols, five blocked symbols (`AAPL`, `AMD`, `AVGO`, `INTC`, `NVDA`),
  and three missing symbols (`AMZN`, `GOOGL`, `ORCL`).
- Live quant evidence was informational but degraded: latest metrics were updated at `2026-05-07T16:09:03.568Z`,
  while `max_stage_lag_seconds=523984`.
- Direct CNPG SQL was RBAC-blocked for `torghut-db-1`, so typed runtime endpoints are the available database witness.

### Simulation Evidence

- Simulation `/readyz` returned HTTP `200` in paper mode.
- Simulation proof floor remained `repair_only`, route state `repair_only`, capital state `zero_notional`, and
  `max_notional=0`.
- Simulation blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
  `market_context_stale`.
- Simulation TCA had four orders, five filled executions, latest TCA at `2026-05-06T18:00:43.661339+00:00`, average
  absolute slippage `5.577112285` bps, one routeable symbol (`NVDA`), and seven missing symbols.
- Simulation quant evidence was informational with missing latest metrics and missing pipeline stages.

### Source Evidence

- `services/torghut/app/main.py` is 4186 lines and should not absorb another capital decision subsystem.
- `services/torghut/app/trading/proof_floor.py` is 680 lines and already emits floor state, route state, capital
  state, blockers, proof dimensions, and repair ladder.
- `services/torghut/app/trading/tca.py` is 969 lines and owns execution TCA metrics and symbol routeability.
- `services/torghut/app/trading/submission_council.py` is 1199 lines and remains the deterministic submission gate.
- `services/torghut/app/trading/revenue_repair.py` is 638 lines and can summarize repair posture but does not yet
  emit routeable edge repair records.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4349 lines and should consume capital proof provenance, not
  become the proof registry.
- `rg` found `profit_contract_actuation`, `capital_unlock_receipts`, and `capital_contract_not_actuated` only in
  accepted docs, not in live source modules.

## Problem

Torghut can say why capital is closed, but it does not yet prove which repair created a capital-eligible route. The
current live state has zero routeable symbols. Simulation has one routeable symbol but still lacks market context,
alpha readiness, and most route TCA. Treating either state as capital-ready would be false precision.

The current failure modes are:

1. A fresh quant metric can coexist with a very stale pipeline stage.
2. Aggregate TCA can hide that the live routeable universe is empty.
3. Simulation can be HTTP `200` while still being zero-notional.
4. A repair ladder can rank work without proving before/after routeability or post-cost edge.
5. Jangar source provenance can be missing while Torghut asks for capital action.

## Alternatives Considered

### Option A: Keep Proof Floor As The Only Capital Gate

Pros:

- It already fails closed.
- It is tested and visible in `/readyz`.
- It prevents accidental live trading today.

Cons:

- It does not attribute routeability changes to repairs.
- It cannot tell Jangar which capital proof is source-provenanced.
- It does not make quant lag and symbol-route completeness a capital receipt.

Decision: reject as incomplete.

### Option B: Unlock Paper When Any Simulation Symbol Is Routeable

Pros:

- It would accelerate learning.
- It uses existing TCA symbol-route data.
- It gives a concrete next canary candidate.

Cons:

- Simulation currently has only one routeable symbol and seven missing symbols.
- Market context and alpha readiness still block paper capital.
- It would weaken the zero-notional discipline before live routeability is repaired.

Decision: reject. It is too optimistic for the evidence.

### Option C: Add Capital Proof Provenance And Routeable Edge Repair Records

Pros:

- Measures the repair path that actually matters for capital: routeable post-cost edge.
- Gives Jangar one receipt to consume before material capital action.
- Keeps observation and repair running while capital stays closed.
- Makes quant lag, market context, alpha readiness, TCA, and source provenance part of the same proof window.

Cons:

- Adds a reducer and persistence surface.
- Requires before/after snapshots to avoid false credit.
- Keeps capital closed until routeability and provenance improve together.

Decision: select Option C.

## Architecture

Add a pure `capital_proof_provenance` reducer under `services/torghut/app/trading/` and persist repair outcomes in a
`routeable_edge_repair_ledger`. The reducer consumes existing proof-floor output, TCA symbol routes, market-context
freshness, alpha readiness, quant ingestion state, live submission policy, contract actuation state, and Jangar source
provenance leases.

`CapitalProofProvenanceReceipt` fields:

- `receipt_id`
- `account_label`
- `hypothesis_id`
- `capital_surface`: `observe`, `repair`, `paper_canary`, `live_micro_canary`, or `live_scale`
- `proof_window_start`
- `proof_window_end`
- `proof_floor_state`
- `route_state`
- `capital_state`
- `routeable_symbol_count`
- `blocked_symbol_count`
- `missing_symbol_count`
- `scoped_symbols`
- `tca_guardrail_bps`
- `avg_abs_slippage_bps`
- `market_context_state`
- `alpha_readiness_state`
- `quant_stage_lag_seconds`
- `jangar_source_provenance_ref`
- `contract_actuation_refs`
- `decision`: `allow`, `repair_only`, `hold`, or `block`
- `blocking_reason_codes`
- `fresh_until`
- `rollback_target`

`RouteableEdgeRepairRecord` fields:

- `repair_id`
- `repair_dimension`
- `hypothesis_ids`
- `account_label`
- `started_at`
- `closed_at`
- `routeable_symbols_before`
- `routeable_symbols_after`
- `blocked_symbols_before`
- `blocked_symbols_after`
- `missing_symbols_before`
- `missing_symbols_after`
- `avg_abs_slippage_bps_before`
- `avg_abs_slippage_bps_after`
- `market_context_before`
- `market_context_after`
- `quant_lag_before_seconds`
- `quant_lag_after_seconds`
- `alpha_ready_before`
- `alpha_ready_after`
- `post_cost_edge_bps_delta`
- `capital_effect`: `none`, `observe`, `paper_candidate`, `live_micro_candidate`, or `live_scale_candidate`
- `jangar_source_provenance_ref`
- `rollback_target`

Capital rules:

- `observe` is allowed when dependencies are healthy enough to measure.
- `repair` is allowed with zero notional when proof floor is repair-only and Jangar permits repair-only dispatch.
- `paper_canary` requires at least two scoped routeable symbols, fresh market context, alpha readiness, quant lag below
  900 seconds for required stages, and current Jangar source provenance.
- A single-symbol paper canary is allowed only as an explicitly named exception with max notional zero until the second
  routeable symbol appears.
- `live_micro_canary` requires live routeability, passing scoped TCA, live submission enabled, and Jangar material
  action escrow released for the capital action.
- `live_scale` requires sustained live micro evidence across at least two independent sessions and no stale Jangar or
  Torghut provenance.

## Measurable Trading Hypotheses

Hypothesis 1: If live routeability is repaired by excluding missing and high-slippage symbols, routeable live symbol
count should move from 0 to at least 2 before any paper canary is considered. Guardrail: zero notional until routeable
symbol count is at least 2 or an explicit zero-notional single-symbol exception is recorded.

Hypothesis 2: If quant ingestion lag exceeds 900 seconds for a required capital surface, then fresh metric timestamps
are insufficient capital proof. Guardrail: `quant_stage_lag_exceeded` blocks paper and live capital even when the
latest metrics timestamp is recent.

Hypothesis 3: If market context remains stale, alpha readiness should stay shadow-only even when TCA routeability
improves. Guardrail: `market_context_stale` blocks paper and live capital until a fresh context receipt is in the same
proof window as the routeability repair.

Hypothesis 4: If a routeable-edge repair closes only simulation blockers, live capital remains closed. Guardrail:
simulation repair records can nominate live experiments, but cannot authorize live notional without a live receipt.

## Validation Gates

Engineer validation:

- Add `services/torghut/app/trading/capital_proof_provenance.py`.
- Add tests proving live zero routeable symbols produce `decision=hold` or `block` for paper/live capital.
- Add tests proving simulation HTTP `200` does not imply capital readiness when proof floor is repair-only.
- Add tests proving quant lag above 900 seconds blocks capital even when latest metric time is fresh.
- Add tests proving missing Jangar source provenance blocks paper/live capital and leaves observe/repair available.
- Add tests for before/after routeable edge repair records.

Deployer validation:

- Before paper or live widening, query Torghut `/readyz` and `/trading/status`.
- Require a fresh `CapitalProofProvenanceReceipt` for the requested capital surface.
- Require Jangar `MaterialActionEscrow.release_state=released` for paper/live capital.
- If any required receipt is absent, expired, design-only, or held, keep `capital_state=zero_notional`.

Data validation:

- Use typed runtime endpoints as witnesses when CNPG SQL is RBAC-blocked.
- Record RBAC limitations as validation debt.
- Persist routeable-edge repair records only after both before and after snapshots are present.

## Rollout

Phase 0 adds the reducer and tests with status publication in shadow mode.

Phase 1 publishes `capital_proof_provenance` from `/readyz`, `/trading/health`, and `/trading/status`, but leaves
proof-floor decisions unchanged.

Phase 2 adds routeable edge repair records for TCA, market context, quant ingestion, and alpha readiness repairs.

Phase 3 lets Jangar consume Torghut capital proof provenance in shadow mode for `paper_canary`, `live_micro_canary`,
and `live_scale`.

Phase 4 allows a paper canary only when the receipt is current, routeability is scoped, market context is fresh, alpha
readiness is positive, quant lag is within budget, and Jangar source provenance is current.

## Rollback

If the reducer fails, omit `capital_proof_provenance` and keep existing proof-floor zero-notional behavior.

If the routeable edge ledger produces false positives, downgrade all affected receipts to `repair_only`, keep live
submit disabled, and require the prior proof-floor blockers.

If Jangar source provenance is absent or expired, Torghut capital remains zero-notional and repair records stay
observation-only.

## Risks

- Routeability can improve by excluding too much of the universe; enforce minimum scoped-symbol count and cost checks.
- Quant lag thresholds may need per-surface tuning after the first implementation pass.
- The ledger can over-credit repairs unless before/after snapshots are immutable.
- Jangar and Torghut provenance clocks can drift; capital must fail closed on disagreement.

## Handoff To Engineer

Implement Torghut after or alongside the Jangar source provenance lease behind fixtures. The smallest accepted slice is:

1. Add `capital_proof_provenance.py` with pure classification over current proof floor, TCA, market context, alpha,
   quant, and Jangar provenance inputs.
2. Publish the receipt in shadow mode from ready and status endpoints.
3. Add tests for zero routeable live symbols, simulation repair-only readiness, stale quant lag, and missing Jangar
   provenance.
4. Add a routeable edge repair record model or typed in-memory fixture before persistence.
5. Keep proof-floor zero-notional behavior unchanged until deployer gates consume the receipt.

## Handoff To Deployer

Do not widen paper or live capital from proof-floor dependency health alone. Require a fresh
`CapitalProofProvenanceReceipt` and a released Jangar `MaterialActionEscrow` for the requested surface. If the receipt
is absent, expired, design-only, or disagrees with proof floor, keep Torghut zero-notional. Observation and repair-only
work can continue when dependencies are healthy enough to measure and Jangar permits repair-only dispatch.
