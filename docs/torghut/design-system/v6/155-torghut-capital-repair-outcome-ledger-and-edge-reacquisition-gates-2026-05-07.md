# 155. Torghut Capital Repair Outcome Ledger And Edge Reacquisition Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders architecture
Scope: Torghut profitability, capital repair outcome settlement, post-cost edge reacquisition, proof-floor closure,
Jangar repair outcome feedback, validation, rollout, rollback, and implementation handoff.

Companion Jangar contract:

- `docs/agents/designs/151-jangar-repair-outcome-settlement-and-schedule-debt-roi-exchange-2026-05-07.md`

Extends:

- `154-torghut-marginal-proof-spend-portfolio-and-capital-repair-budget-2026-05-07.md`
- `153-torghut-useful-evidence-capital-escrow-and-provider-repair-gates-2026-05-07.md`
- `152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`

## Decision

I am selecting a capital repair outcome ledger as the next Torghut profitability architecture step.

The proof-spend portfolio ranks the repair that should run next. The fresh runtime evidence says that is still one
step short of what Torghut needs. Live Torghut is available, its core dependencies are healthy, and empirical jobs are
fresh. The system is still correctly zero-notional because proof floor is `repair_only`, execution TCA breaches the
slippage guardrail, market context is stale, alpha readiness has no promotion-eligible hypotheses, and live submit is
disabled. Running a repair is not enough. Torghut must settle whether the repair reacquired edge.

The selected design adds `CapitalRepairOutcome` receipts. Each receipt records the proof-floor state before repair,
the proof-floor state after repair, the cost of the repair, the measured blocker delta, the post-cost edge delta, and
the capital reentry decision. A repair earns future Jangar and Torghut budget only when it closes a blocker, converts a
blocker into a more precise no-go, or improves post-cost edge in the target evidence window.

The tradeoff is that Torghut has to measure repair outcomes as a portfolio instead of treating repair completion as a
success. I accept that. Profitability comes from allocating capital and engineering time to repairs that change the
expected return distribution, not from clearing job statuses.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `capital_repair_outcomes` from `/trading/status` and `/trading/health`.
- Every proof-spend bid that runs produces a `CapitalRepairOutcome`.
- Outcomes show before and after values for proof floor, TCA, market context, alpha readiness, quant ingestion, and
  submit-gate state.
- Repair classes are graded as `edge_reacquired`, `blocker_closed`, `blocker_converted`, `no_effect`, `regressed`, or
  `stale`.
- Paper widening is allowed only after a closed or edge-reacquired outcome and positive post-cost edge.
- Live remains zero-notional until proof floor, submission council, and Jangar repair outcome settlement agree.
- Jangar receives outcome summaries so future proof-spend tokens prefer repairs with observed capital impact.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07 around 15:11Z. I did not mutate Kubernetes resources, database
records, ClickHouse tables, broker state, GitOps resources, or trading flags.

### Runtime And Cluster Evidence

- Live Torghut active deployment `torghut-00267-deployment` was `1/1` and the active pod was `2/2 Running`.
- Simulation active deployment `torghut-sim-00367-deployment` was `1/1` and its pod was `2/2 Running`.
- Current Torghut image digest was
  `sha256:8db8a40ee7f76c08aaa0689b55e145dfaf872248707a20fb38c005e0eabb42ab`.
- Torghut options catalog, options enricher, TA, TA simulation, options TA, WebSocket services, ClickHouse, Keeper,
  Postgres, guardrail exporters, and Symphony Torghut pods were running.
- A pre-existing `torghut-whitepaper-autoresearch-profit-target` pod was in `Error`.
- Recent events showed DB migrations and backfill jobs completing, WebSocket rollout readiness churn, Flink
  status-modified-externally warnings, and duplicate ClickHouse PodDisruptionBudget warnings.
- Direct CNPG SQL was RBAC-blocked for `torghut-db-1`; typed runtime endpoints are the available database and
  freshness witnesses for this architecture lane.

### Data And Proof Evidence

- Live `/readyz` returned `status=degraded`.
- Live Postgres, ClickHouse, Alpaca, database schema, Jangar universe, readiness cache, and empirical jobs were healthy.
- Live Alpaca endpoint class was `live`; account status was `ACTIVE`.
- Database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage was ready with one branch, no duplicate revisions, no orphan parents, and known parent-fork warnings
  at `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Jangar universe was fresh with 8 symbols and cache age about 150 seconds.
- Empirical jobs were healthy for candidate `chip-paper-microbar-composite@execution-proof` and dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Live submission gate was closed: `simple_submit_disabled`, `capital_stage=shadow`.
- Live proof floor was `floor_state=repair_only`, `route_state=repair_only`, `capital_state=zero_notional`, and
  `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`,
  `market_context_stale`, and `simple_submit_disabled`.
- Alpha readiness had `promotion_eligible_total=0`, `rollback_required_total=3`, and `state_totals.shadow=3`.
- Execution TCA had `13,775` orders, `13,571` filled executions, average absolute slippage
  `13.7594875295276693` bps, and an `8` bps slippage guardrail.
- Quant ingestion was degraded but informational for live readiness, with latest metrics updated at
  `2026-05-07T15:10:53.611Z` and maximum stage lag `77172` seconds.
- Simulation `/readyz` returned `status=ok` in paper mode, but its proof floor still reported `repair_only`,
  `zero_notional`, stale market context, no promotion-eligible alpha, and execution TCA above guardrail.

### Source Evidence

- `services/torghut/app/main.py` is 4186 lines and should remain route assembly, not repair outcome economics.
- `services/torghut/app/trading/proof_floor.py` is 653 lines and already emits proof dimensions, blockers,
  capital state, and repair ladder entries.
- `services/torghut/app/trading/tca.py` is 969 lines and owns execution TCA refresh and metrics.
- `services/torghut/app/trading/empirical_jobs.py` is 561 lines and owns empirical freshness authority.
- `services/torghut/app/trading/submission_council.py` is 1199 lines and remains the final deterministic submission
  gate.
- `services/torghut/app/trading/hypotheses.py` is 764 lines and owns hypothesis state and promotion eligibility.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4349 lines and should consume outcome decisions rather than
  embed more repair scoring logic.
- Existing tests cover proof floor, TCA policy, empirical jobs, market context, submission council, hypotheses, and
  quant readiness. Missing tests are repair outcome delta, edge reacquisition, and Jangar feedback fixtures.

## Problem

Torghut can now expose a repair ladder and rank proof spend, but capital reentry still needs an after-action ledger.
The system should not pay the same budget to every completed repair. A TCA recompute that confirms slippage is still
too high is useful, but it is not a capital unlock. A market-context refresh that writes fresh data but changes no
hypothesis decision is maintenance, not edge reacquisition. An alpha readiness repair that leaves zero promotion
eligible hypotheses should reduce future priority unless it converted the blocker into a more precise no-go.

Without outcome settlement, Torghut risks spending controller tokens, data cost, and engineering time on repairs that
create fresh evidence without improving post-cost return. That is how a zero-notional system can stay busy while not
moving closer to profitable paper or live capital.

## Alternatives Considered

### Option A: Keep Capital Closed Until Every Proof-Floor Blocker Is Green

Pros:

- Safest notional posture.
- Easy for deployers to enforce.
- Avoids new outcome accounting.

Cons:

- Does not rank which repair changed the system.
- Makes engineering time allocation opaque.
- Blocks paper learning even after a repair closes a hypothesis-local blocker.

Decision: reject as too blunt.

### Option B: Trust Proof-Spend Bid Completion As The Outcome

Pros:

- Minimal implementation after the proof-spend portfolio.
- Keeps scheduler logic simple.
- Preserves momentum.

Cons:

- Confuses repair completion with edge reacquisition.
- Cannot penalize no-effect repairs.
- Cannot prove paper or live capital should reenter.

Decision: reject as unsafe for profitability.

### Option C: Add A Capital Repair Outcome Ledger

Pros:

- Measures blocker delta and edge delta after repair.
- Lets Torghut and Jangar allocate future repair budget by observed value.
- Separates measurement closure, policy closure, and actual capital reentry.
- Gives deployers concrete evidence for paper and live gates.

Cons:

- Adds one reducer and one persisted receipt surface.
- Requires careful windows so outcomes are not judged too early.
- Needs calibration before it can drive paper or live gating.

Decision: select Option C.

## Architecture

Add a `capital_repair_outcomes` reducer under `services/torghut/app/trading/`.

`CapitalRepairOutcome` fields:

- `outcome_id`: deterministic hash of repair bid, account, hypothesis set, source revision, and evidence window.
- `repair_bid_id`: proof-spend bid that produced the outcome.
- `jangar_repair_outcome_receipt_id`: companion Jangar receipt, when available.
- `account_label`: paper or live account label.
- `hypothesis_ids`: hypotheses affected by the repair.
- `repair_dimension`: `execution_tca`, `market_context`, `alpha_readiness`, `quant_ingestion`, `live_submit_gate`,
  or `forecast_registry`.
- `repair_class`: `measurement`, `policy`, `data_refresh`, `strategy_research`, or `operator_clearance`.
- `before_proof_floor`: floor state, route state, capital state, blockers, and proof dimensions before repair.
- `after_proof_floor`: same fields after the settlement window.
- `blocker_delta`: blockers closed, added, or converted.
- `post_cost_edge_delta_bps`: expected or measured edge change after spread, fees, slippage, data cost, and repair
  reserve.
- `tca_delta`: average absolute slippage, filled executions, unsettled executions, and guardrail state delta.
- `market_context_delta`: freshness, quality, domain state, and hypothesis-local decision delta.
- `alpha_readiness_delta`: promotion-eligible count, rollback-required count, and state transition delta.
- `quant_ingestion_delta`: lag and missing-stage delta.
- `repair_cost`: controller tokens, runtime cost, data cost, and operator cost.
- `outcome`: `edge_reacquired`, `blocker_closed`, `blocker_converted`, `no_effect`, `regressed`, or `stale`.
- `capital_reentry_decision`: `observe_only`, `repair_only`, `paper_candidate`, `live_hold`, or `live_candidate`.
- `fresh_until`: expiry timestamp for capital use.
- `rollback_target`: safe state if the outcome later contradicts itself.

Outcome rules:

- `edge_reacquired`: post-cost edge becomes positive and all hypothesis-local blockers clear for the evidence window.
- `blocker_closed`: at least one blocker clears, but capital still cannot widen.
- `blocker_converted`: a broad blocker becomes a narrower typed no-go or policy repair.
- `no_effect`: repair ran and no measured dimension moved.
- `regressed`: repair worsened blocker count, slippage, freshness, lag, or readiness.
- `stale`: source or evidence window expired before settlement.

Capital reentry policy:

- Observe remains available when no notional exposure can be submitted.
- Repair remains available with zero notional when an outcome names a concrete closure metric.
- Paper canary requires `edge_reacquired` or a targeted `blocker_closed` outcome plus positive post-cost edge for the
  hypothesis window.
- Live micro-canary requires paper evidence, proof floor pass, submission council allow, no open live blocker, and a
  non-regressed Jangar outcome receipt.
- Live scale is out of scope until repeated live micro-canary receipts prove realized edge and drawdown behavior.

## Measurable Trading Hypotheses

Hypothesis 1: Execution TCA repair is only profitable when it either moves average absolute slippage below the
`8` bps guardrail or converts the blocker into a strategy-specific no-go.

- Metric: average absolute slippage delta, filled execution count, and guardrail state.
- Gate: TCA outcome must move from `execution_tca_slippage_guardrail_exceeded` to pass, or produce a typed no-go that
  stops wasting capital on the affected hypothesis.
- Failure condition: TCA refresh is fresh but average absolute slippage remains near `13.759` bps with no policy
  change.

Hypothesis 2: Market-context repair creates profit only when freshness changes a hypothesis-local decision.

- Metric: domain freshness, quality score, accepted decision precision, and promotion-eligible hypothesis count.
- Gate: refreshed context must close `market_context_stale` and change alpha readiness or decision selectivity.
- Failure condition: context freshness improves but alpha readiness and accepted decision precision do not move.

Hypothesis 3: Alpha-readiness repair should unlock paper before live.

- Metric: promotion-eligible count, rollback-required count, and paper outcome edge.
- Gate: at least one hypothesis moves from shadow to paper candidate with positive post-cost edge.
- Failure condition: repair leaves `promotion_eligible_total=0` or increases rollback-required hypotheses.

Hypothesis 4: Jangar outcome feedback increases useful repairs per controller token.

- Metric: blocker closures per admitted Jangar repair token.
- Gate: after feedback is enabled, no-effect repair tokens fall or stay flat while closure count rises.
- Failure condition: feedback increases controller restarts, failed attempts, or proof query latency without blocker
  closure.

## Guardrails

- No live notional while proof floor is `repair_only` or `capital_state=zero_notional`.
- No paper widening from a repair outcome that is `no_effect`, `regressed`, `stale`, or `unknown`.
- No TCA repair can claim edge until it clears the guardrail or emits a narrower no-go.
- No market-context repair can claim edge from freshness alone; it must produce hypothesis-local decision movement.
- No alpha-readiness repair can claim capital reentry while promotion-eligible count remains zero.
- No repair outcome can increase Jangar budget without a companion Jangar receipt or an explicit deployer waiver.

## Implementation Scope

Engineer stage:

- Add `capital_repair_outcomes.py` under `services/torghut/app/trading/`.
- Build outcomes from proof-spend bids, proof-floor receipts, TCA metrics, market-context status, hypothesis
  readiness, quant ingestion state, submission council state, and optional Jangar repair outcome receipts.
- Add outcome summaries to `/trading/status` and `/trading/health`; keep `/readyz` lightweight and cache-aware.
- Persist outcomes with indexes on account, repair dimension, hypothesis, outcome, `fresh_until`, and source revision.
- Add tests for TCA blocker closed versus blocker converted, market context freshness with no hypothesis delta,
  alpha readiness movement, no-effect repair, regressed repair, stale source, and Jangar feedback absence.
- Add fixtures using the current live blocker shape: zero notional, `13.759` bps average absolute slippage,
  stale market context, zero promotion-eligible hypotheses, and simple submit disabled.

Deployer stage:

- Roll out in shadow mode and publish outcomes without admission impact.
- Enable repair budget feedback after one full trading day of outcomes.
- Enable paper canary gate after outcome false positives are reviewed.
- Keep live disabled until proof floor, submission council, paper outcomes, and Jangar repair outcomes all agree.

## Validation Gates

- Unit: a TCA refresh that leaves slippage above `8` bps is not `edge_reacquired`.
- Unit: a TCA repair that converts high slippage into a strategy-specific no-go is `blocker_converted`, not failure.
- Unit: market-context freshness without hypothesis-local movement is `no_effect` for capital reentry.
- Unit: alpha readiness repair with `promotion_eligible_total=0` cannot produce `paper_candidate`.
- Unit: live submit disabled keeps `capital_reentry_decision=repair_only` or `observe_only`.
- Integration fixture: current live `/readyz` and `/trading/status` payloads produce zero live notional and ranked
  repair outcomes, not paper or live admission.
- Performance: outcome reducer completes under 100 ms on production-sized proof-floor and hypothesis fixtures.
- Database: latest outcome lookup for one account and hypothesis completes under 500 ms with a statement timeout.

## Rollout And Rollback

Rollout sequence:

1. `shadow`: compute and display outcomes.
2. `feedback`: send outcome grades to Jangar proof-spend budget but do not gate paper.
3. `paper-gate`: require closed or edge-reacquired outcomes for paper canary.
4. `live-hold`: keep live disabled unless paper outcomes and proof floor agree.
5. `live-micro`: allow only deployer-approved micro-canary after repeated positive paper outcomes.

Rollback:

- Disable paper and live outcome gates first.
- Keep shadow outcome calculation if it does not add route latency.
- If outcome calculation causes latency, remove it from `/trading/health` and keep it on `/trading/status`.
- Fall back to proof floor and submission council, with live capital still zero notional while proof floor is
  `repair_only`.

## Risks

- Outcome windows can be too short and mark useful repair as no-effect. Mitigation: each repair dimension owns a
  settlement window and explicit `fresh_until`.
- Post-cost edge estimates can be noisy. Mitigation: paper gate first, live micro only after repeated evidence.
- TCA can dominate repair budget. Mitigation: cap one repair dimension's budget share until closure data proves value.
- Jangar feedback can starve slow but necessary repairs. Mitigation: use `blocker_converted` as a useful outcome when
  it makes the next repair more precise.

## Handoff Contract

Engineer acceptance gates:

- Outcome reducer and tests cover all validation gates above.
- Route additions are additive and do not slow readiness beyond the existing readiness cache budget.
- Outcome payloads name source revision, repair cost, blocker delta, edge delta, settlement window, and rollback
  target.
- Zero-notional enforcement is deterministic.

Deployer acceptance gates:

- Shadow outcomes run for one full trading day before feedback.
- Feedback mode reduces no-effect proof-spend or keeps it flat while closing at least one blocker.
- Paper gate does not admit paper widening without positive post-cost edge.
- Live remains disabled until proof floor, submission council, paper outcomes, and Jangar outcome settlement all agree.
