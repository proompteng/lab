# 163. Torghut Quant Stage Cohort And Evidence Repair Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut profitability, quant stage coverage, empirical proof repair, routeability repair, no-notional capital
discipline, Jangar authority-surface consumption, validation, rollout, rollback, and handoff.

Companion Jangar contract:

- `docs/agents/designs/159-jangar-authority-surface-settlement-and-quant-stage-cohort-gates-2026-05-07.md`

Extends:

- `162-torghut-profit-evidence-refill-and-capital-route-reentry-2026-05-07.md`
- `161-torghut-shadow-capital-parity-and-no-notional-release-train-2026-05-07.md`
- `160-torghut-proof-surface-activation-ledger-and-capital-receipt-firewall-2026-05-07.md`

## Decision

I am selecting quant stage cohorts with evidence repair settlement as Torghut's next profitability architecture step.

The current system is safer than it was earlier in the day. Torghut live and simulation pods are running, TA pipelines
are producing fresh symbols, the route-reacquisition book is active in runtime, and the database schema is current.
That does not make the system capital-ready. `/readyz` and `/trading/health` remain degraded. Live capital is
zero-notional. Simple submit is disabled. The live route universe has zero routeable symbols. Empirical jobs are stale.
Alpha readiness has three shadow hypotheses, zero promotion-eligible hypotheses, and three rollback-required
hypotheses.

The most important finding is that freshness is now multi-layered. Jangar quant health for the live account/window has
144 latest metric rows, but it is still degraded because update cadence is outside the 15 second alarm threshold and
there are no stage receipts. The TA stream itself is fresh for `NVDA`. Execution TCA was refreshed today, but the
latest execution base is old and average absolute slippage is above the guardrail. A single latest metric count cannot
stand in for a complete proof cohort.

Torghut should publish a `quant_stage_cohort` and an `evidence_repair_settlement`. The cohort groups TA freshness,
latest metric projection, pipeline stages, empirical jobs, market context, routeability, TCA, alpha readiness, and
Jangar authority-surface settlement into one proof window. The repair settlement ranks bounded no-notional repairs
that can improve that cohort without granting paper or live capital.

The tradeoff is deliberate friction. This design may refill proof and still keep capital closed. That is the correct
outcome until stage coverage, routeability, alpha readiness, market context, and Jangar authority all agree.

## Runtime Objective And Success Metrics

Success means:

- `/readyz`, `/trading/health`, and `/trading/status` expose `quant_stage_cohort` and
  `evidence_repair_settlement`.
- A cohort records the account, proof window, Torghut revision, Jangar authority-surface settlement, TA freshness,
  latest metric projection, stage coverage, empirical jobs, routeability, TCA, market context, alpha readiness, and
  submission gate.
- A nonempty latest metric projection can clear only the `latest_projection` stage. It cannot clear missing empirical,
  routeability, market-context, TCA, or alpha-readiness stages.
- Evidence repair can run under `no_notional` only when Jangar admits the repair class through
  `authority_surface_settlement` and `quant_stage_cohort_gate`.
- Paper canary requires at least two routeable symbols, fresh market context, current empirical jobs, complete quant
  stage receipts, alpha readiness promotion eligibility, average absolute slippage at or below the active guardrail,
  and no unresolved Jangar authority split.
- Live micro canary additionally requires live submit enabled, zero rollback-required alpha entries, route provenance
  coverage at or above 95 percent, current TCA, and no critical quant alerts.
- Deployer output can reject capital with one cohort ID, one repair settlement ID, and finite reason codes.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records, ClickHouse
tables, GitOps resources, AgentRun objects, broker state, empirical artifacts, or trading flags.

### Cluster And Runtime Evidence

- The current workspace branch was `codex/swarm-torghut-quant-discover`, based on `origin/main` at
  `1c61d12d7f962f564234f3ae66d7deb09aae7176`.
- `kubectl auth whoami` succeeded as `system:serviceaccount:agents:agents-sa`; the Kubernetes current context itself
  was unset.
- Torghut runtime pods were running after a fresh rollout: `torghut-00276-deployment` was `1/1`,
  `torghut-sim-00376-deployment` was `1/1`, `torghut-ta` and `torghut-ta-sim` were running, and TA taskmanagers were
  coming up under the new restart nonce.
- Recent events showed transient readiness/startup probe failures during revision handoff and Flink state restart
  reconciliation. The current pods were running, but rollout freshness alone is not a trading proof.
- A retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod remained in `Error`.
- The service account could not exec into Postgres or ClickHouse pods and could not list Knative or FlinkDeployment
  resources, so typed HTTP endpoints are the database/data witnesses for this pass.

### Database And Data Evidence

- `GET http://torghut.torghut.svc.cluster.local/db-check` returned `ok=true`.
- The current and expected Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage was ready with one branch, no duplicate revisions, no orphan parents, and known parent-fork warnings
  at `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/readyz` reported Postgres `ok`, ClickHouse `ok`, Alpaca live account `PA3SX7FYNUTF` active, and Jangar universe
  fresh with eight symbols.
- Jangar TA latest for `NVDA` returned TA bars and signals at `2026-05-07 18:10:35`, which proves the raw TA stream was
  fresh for at least one key symbol.
- Jangar quant health for account `PA3SX7FYNUTF` and window `15m` returned `latestMetricsCount=144` and
  `latestMetricsUpdatedAt=2026-05-07T18:10:03.174Z`, but status was `degraded`, `missingUpdateAlarm=true`,
  `missingUpdateThresholdSeconds=15`, and `stages=[]`.
- Torghut empirical jobs were stale relative to the 86400 second budget. The latest job rows were created at
  `2026-05-06T16:27:32.941330Z` for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.

### Trading Evidence

- `/readyz` and `/trading/health` returned `status=degraded`.
- The scheduler was running and startup grace was inactive.
- Live proof floor was `repair_only`; route state was `repair_only`; capital state was `zero_notional`; max notional
  was `0`.
- Live submission gate was closed with reason `simple_submit_disabled` and capital stage `shadow`.
- Alpha readiness had three hypotheses, all shadow; zero were promotion eligible; all three required rollback.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Execution TCA had 7334 orders and 7245 filled executions. Latest TCA was
  `2026-05-07T14:23:43.480686Z`, while latest execution creation was `2026-04-02T19:00:29.586040Z`.
- Average absolute slippage was `13.8203637593029676` bps against an `8` bps guardrail.
- Route reacquisition was active and correctly severe: live had zero routeable symbols, five blocked symbols
  (`AAPL`, `AMD`, `AVGO`, `INTC`, `NVDA`), and three missing symbols (`AMZN`, `GOOGL`, `ORCL`).
- Blocked symbols were not marginal. `AAPL` averaged `9.2512` bps, `NVDA` `13.4759` bps, `AMD` `14.9333` bps,
  `INTC` `20.5711` bps, and `AVGO` `21.8583` bps against the 8 bps guardrail.

### Source Evidence

- `services/torghut/app/main.py` is 4188 lines and still carries readiness, health, whitepaper, trading, proof-floor,
  status, and metrics assembly.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4349 lines and remains the high-risk decision pipeline.
- `services/torghut/app/whitepapers/workflow.py` is 4473 lines and is orthogonal but large enough to affect service
  startup and runtime risk.
- `services/torghut/app/trading/proof_floor.py`, `route_reacquisition.py`, `tca.py`, `revenue_repair.py`, and
  `submission_council.py` already provide most raw ingredients for stage cohorts.
- The trading package has 127 Python modules and the service has 144 test files, so the next change should add a pure
  reducer and focused contract tests rather than increase `main.py` or scheduler coupling.
- The missing test surface is stage-cohort classification: fresh TA plus nonempty latest metrics plus missing stages
  plus stale empirical jobs plus zero routeability must classify as repair-only, never paper-capital-ready.

## Problem

Torghut has moved past the first reliability problem. The system can stay alive and fail closed. The profitability
problem is now proof cohesion:

1. TA data can be fresh while quant stage receipts are absent.
2. Latest metrics can be nonempty while empirical jobs are stale.
3. TCA can be recently recomputed from old executions and still fail the routeability guardrail.
4. Route reacquisition can identify repair candidates without making any symbol routeable.
5. Jangar can allow observation while still holding material action and capital classes.

If Torghut treats any one of those surfaces as enough, it will promote weak evidence. If it treats all degraded states
as identical, it will waste repair capacity. The missing object is a cohort that says which proof stages are current,
which repairs are useful, and which capital surfaces remain forbidden.

## Alternatives Considered

### Option A: Refresh All Empirical Jobs First

Pros:

- Directly addresses one clear blocker.
- Keeps paper and live capital closed.
- Reuses the existing empirical job workflow.

Cons:

- It does not repair missing quant stage receipts.
- It does not improve routeability or market context.
- It does not distinguish high-value repairs from low-value freshness churn.

Decision: reject as the architecture default. It remains a valid repair class inside the selected design.

### Option B: Let Fresh TA And Latest Metrics Unlock Paper Candidates

Pros:

- Fastest route to paper feedback.
- TA is fresh and latest metrics are present for the live account/window.
- It would generate new execution observations sooner.

Cons:

- There are zero routeable live symbols.
- Empirical jobs are stale.
- Quant stages are empty.
- Alpha readiness is shadow-only with all hypotheses rollback-required.
- Live submit is disabled.

Decision: reject. This would turn partial freshness into capital authority.

### Option C: Add Quant Stage Cohorts And Evidence Repair Settlement

Pros:

- Separates proof freshness by stage.
- Ranks no-notional repair cells by expected unblock value.
- Consumes Jangar authority-surface settlement before repair work.
- Keeps capital zero-notional until all required stages converge.

Cons:

- Adds a reducer and a status schema.
- Requires before/after evidence for repair credit.
- Keeps paper closed even when a subset of data looks fresh.

Decision: select Option C.

## Architecture

Add a pure `quant_stage_cohort` reducer under `services/torghut/app/trading/`. It should not perform network calls or
database writes. The HTTP assembly layer passes in already gathered proof-floor, TCA, empirical, quant-health,
market-context, alpha-readiness, submission-policy, and Jangar authority evidence.

`QuantStageCohort` fields:

- `cohort_id`
- `account_label`
- `window`
- `service_revision`
- `image_digest`
- `jangar_authority_surface_settlement_id`
- `jangar_quant_stage_cohort_gate_id`
- `generated_at`
- `fresh_until`
- `capital_surface`: `observe`, `repair`, `paper_candidate`, `live_micro_candidate`, `live_scale_candidate`
- `stage_summary`
- `stage_receipts`
- `missing_stages`
- `stale_stages`
- `blocking_reasons`
- `repairable_reasons`
- `decision`: `observe`, `repair_only`, `hold`, or `block`
- `max_notional`
- `rollback_target`

Required stage receipts:

- `ta_freshness`: latest TA event and ingest time per scoped symbol.
- `latest_projection`: Jangar latest metrics count, update time, and missing-update alarm.
- `pipeline_stage_health`: stage names, stage lag, and required stage coverage.
- `empirical_jobs`: required empirical job status, candidate ID, dataset ref, and staleness.
- `routeability`: routeable, blocked, and missing symbol sets with per-symbol TCA guardrail status.
- `execution_tca`: sample count, latest computation time, latest execution time, and slippage guardrail.
- `market_context`: domain freshness and stale reasons.
- `alpha_readiness`: promotion-eligible and rollback-required counts.
- `submission_policy`: simple-submit, paper/live mode, and emergency stop status.
- `jangar_authority`: authority-surface decision and allowed action classes.

Add `evidence_repair_settlement` as a ranked no-notional repair board.

`EvidenceRepairCell` fields:

- `cell_id`
- `repair_class`
- `target_stage`
- `before_ref`
- `after_ref`
- `expected_unblock_value`
- `expected_cost`
- `falsification_check`
- `allowed_by_jangar`
- `max_runtime_seconds`
- `max_dispatches`
- `capital_authority`: always `none`
- `success_gate`
- `rollback_trigger`
- `decision`
- `reason_codes`

Allowed repair classes:

- `empirical_job_refresh`
- `quant_stage_materialization_refill`
- `market_context_refresh`
- `routeability_probe`
- `tca_projection_refresh`
- `alpha_readiness_recompute`

Capital remains blocked while any required stage is missing, stale, or contradictory.

## Implementation Scope

Torghut engineer owns:

- Add pure reducers for `quant_stage_cohort` and `evidence_repair_settlement`.
- Wire them into `/readyz`, `/trading/health`, and `/trading/status` without growing scheduler coupling.
- Add tests for the current observed state: fresh TA, latest metrics count 144, empty stages, stale empirical jobs,
  zero routeable symbols, slippage above guardrail, shadow alpha readiness, and simple submit disabled.
- Add tests for paper candidate rejection when latest metrics are fresh but stage receipts are missing.
- Add tests for repair-cell ranking and no-notional capital authority.

Jangar engineer provides:

- `authority_surface_settlement_id`
- `quant_stage_cohort_gate_id`
- repair-only admission for named evidence repair classes
- hold/block decisions for paper and live capital classes

## Validation Gates

Minimum local validation:

- `cd services/torghut && uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_route_reacquisition.py tests/test_tca.py`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `bunx oxfmt --check docs/torghut/design-system/v6/163-torghut-quant-stage-cohort-and-evidence-repair-settlement-2026-05-07.md`

Runtime acceptance:

- Current live state classifies as `decision=repair_only` or `hold`, never `paper_candidate`.
- Latest metric count greater than zero does not clear `pipeline_stage_health` when `stages=[]`.
- Empirical job staleness produces repair cells but no capital authority.
- Routeability with zero routeable symbols blocks paper/live and emits repair cells for missing/blocked symbols.
- Deployer can cite one cohort ID and one repair settlement ID for every capital hold.

## Rollout Plan

1. Ship the reducers in shadow mode and expose them in status payloads.
2. Compare cohort decisions to existing proof-floor and live-submission gates for one full market session.
3. Allow Jangar to consume repair cells for no-notional scheduling only.
4. Require complete quant stage cohorts for paper candidate labeling.
5. Require paper settlement plus live-specific gates before any live micro canary.

## Rollback

Rollback is configuration-first:

- Hide or ignore the new cohort fields while keeping existing proof-floor, route-reacquisition, and submission gates.
- Disable Jangar consumption of repair cells.
- Keep capital zero-notional and live submit disabled until the existing gates independently pass.
- Do not delete repair evidence. Expired or failed repair cells are audit inputs for the next cohort.

## Risks And Tradeoffs

- If stage definitions are too broad, all repairs may look blocked. Mitigation: keep stage receipts small and explicit.
- If stage definitions are too narrow, latest metrics could bypass empirical or routeability gaps. Mitigation: paper
  and live candidate labels require every listed stage.
- If repair scoring rewards easy refreshes, it may not improve profitability. Mitigation: rank by expected unblock
  value minus cost and require before/after evidence.
- If Jangar authority remains split, no-notional repair still proceeds only for explicitly allowed classes. That is
  slower but safer than paper promotion.

## Handoff To Engineer And Deployer

Engineer acceptance:

- Implement `quant_stage_cohort` and `evidence_repair_settlement` as pure reducers.
- Add regression tests for fresh latest metrics plus missing stages.
- Keep `capital_authority=none` on every repair cell.
- Wire status output without adding another large decision block to `services/torghut/app/main.py`.

Deployer acceptance:

- Treat `quant_stage_cohort.decision=paper_candidate` as necessary but not sufficient for paper.
- Reject paper/live if any required stage is missing, stale, or not tied to a current Jangar authority settlement.
- Allow only no-notional repair cells until proof floor, routeability, empirical jobs, market context, alpha readiness,
  and Jangar authority all converge.
- Roll back by disabling new consumers, not by relaxing proof-floor or submission gates.
