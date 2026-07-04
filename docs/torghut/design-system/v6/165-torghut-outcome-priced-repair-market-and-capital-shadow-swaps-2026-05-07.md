# 165. Torghut Outcome-Priced Repair Market And Capital Shadow Swaps (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut profitability, zero-notional repair economics, capital shadow swaps, routeability repair, empirical
proof renewal, Jangar brownout clearing, validation, rollout, rollback, and handoff.

Companion Jangar contract:

- `docs/agents/designs/161-jangar-repair-outcome-brownout-market-and-stage-freeze-clearing-2026-05-07.md`

Extends:

- `164-torghut-zero-notional-route-repair-packets-and-paper-rehearsal-2026-05-07.md`
- `163-torghut-quant-stage-cohort-and-evidence-repair-settlement-2026-05-07.md`
- `163-torghut-repair-outcome-attribution-and-capital-reentry-slo-2026-05-07.md`

## Decision

I am selecting an outcome-priced repair market with capital shadow swaps as Torghut's next profitability architecture
step.

The system is serving, but it is not capital-ready. The current live revision is running, the simulation revision is
running, Postgres and ClickHouse checks pass, the database schema is current, and the live quant latest store is no
longer empty. That is progress. It does not change the capital decision: live `/trading/health` is degraded, live
submission is disabled, proof floor is `repair_only`, capital state is `zero_notional`, market context is stale,
empirical services are degraded, alpha readiness has no promotion-eligible hypotheses, and live routeability has zero
routeable symbols.

The profitable move is not to open paper faster. It is to make each zero-notional repair compete by its measured
capital shadow value. A repair should be allowed to spend scheduler and runner capacity only when it can name the
blocker it will reduce, the before proof it will invalidate, the after proof it must produce, and the paper/live
capital surface it could eventually unlock. During the current Jangar brownout, that repair can measure outcomes but
cannot dispatch normally, merge, open paper, or spend live notional.

The tradeoff is that some repairs that look urgent will lose to repairs with clearer after-cost value. I accept that.
Torghut does not need more unpriced proof churn. It needs a portfolio of repair bets where the payoff is a measurable
reduction in route, quant, empirical, market-context, or alpha blockers.

## Runtime Objective And Success Metrics

Success means:

- `/trading/status`, `/trading/health`, and `/trading/autonomy` expose `outcome_priced_repair_market` and
  `capital_shadow_swaps`.
- Every repair market bid has `before_ref`, `required_after_ref`, `target_blocker`, `repair_class`,
  `expected_unblock_value`, `expected_cost`, `max_notional=0`, and a Jangar brownout market decision.
- Capital shadow swaps estimate the paper/live capital surface that would become eligible if the repair succeeds, but
  they do not grant paper or live notional.
- Repairs are ranked by after-cost unblock value, proof age, route scope, falsifiability, and Jangar admissibility.
- Live paper rehearsal remains closed until at least two symbols become routeable or probing with fresh market
  context, quant stage receipts, current empirical proof, acceptable TCA, and Jangar brownout clearing.
- Live micro canary remains blocked until live submit is enabled, routeability is nonzero, alpha rollback count is
  zero, empirical jobs are current, market context is fresh, and Jangar material action classes clear.
- Deployer can reject a proposed repair or capital move using one repair market ID, one capital shadow swap ID, and
  finite reason codes.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 around 19:08Z-19:13Z. I did not mutate Kubernetes resources, database
records, ClickHouse tables, broker state, GitOps resources, AgentRun objects, or trading flags.

### Cluster And Runtime Evidence

- The workspace branch was `codex/swarm-torghut-quant-discover` based on `origin/main` at `479774066`.
- `kubectl auth whoami` succeeded as `system:serviceaccount:agents:agents-sa`.
- Torghut pods were running: current live `torghut-00278-deployment=2/2`, simulation
  `torghut-sim-00378-deployment=2/2`, `torghut-ta=1/1`, `torghut-ta-sim=1/1`, options catalog/enricher `1/1`, and
  Postgres/ClickHouse pods `1/1`.
- `torghut-whitepaper-autoresearch-profit-target-8r6w6` remained in `Error`.
- Recent events showed successful DB migrations and empirical backfill jobs on the latest image, but also rollout
  readiness/startup probe failures during handoff.
- Recent events repeatedly warned that ClickHouse pods match multiple PodDisruptionBudgets and that `torghut-keeper`
  PDB has no matching pods.
- Argo CD reported `torghut` and `torghut-options` as `Synced/Healthy`; cluster platform risk remained in
  `rook-ceph`, `temporal`, `redis-operator`, `cloudnative-pg`, `keycloak`, and `forgejo-runners`.

### Database And Data Evidence

- `GET http://torghut.torghut.svc.cluster.local/db-check` returned `ok=true`.
- Current and expected Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- Schema graph had one branch, no duplicate revisions, no orphan parents, and lineage ready.
- Parent-fork warnings remain documented for `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Account-scope checks were ready, with a warning that they are bypassed while multi-account trading is disabled.
- Direct CNPG `psql` was blocked by RBAC because the service account cannot create `pods/exec` in namespace `torghut`;
  typed service endpoints are the read-only database witnesses for this pass.
- `/whitepapers/status` showed workflow, Kafka, and semantic indexing enabled, but zero recent runs.
- `/trading/autoresearch/epochs?limit=5` returned zero persisted epochs.

### Live Trading Evidence

- Live `/healthz` returned `ok`, while live `/trading/health` returned `status=degraded`.
- Scheduler was running and startup grace was inactive.
- Postgres, ClickHouse, Alpaca live broker/account, Jangar universe, and readiness cache were healthy.
- Live submission gate was closed by `simple_submit_disabled`; capital stage remained `shadow`.
- Proof floor was `repair_only`; route state was `repair_only`; capital state was `zero_notional`; max notional was
  `0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Alpha readiness had three shadow hypotheses, zero promotion eligible, and three rollback required.
- Execution TCA had 7334 orders and 7245 filled executions. Latest TCA computation was
  `2026-05-07T14:23:43.480686Z`, latest execution creation was `2026-04-02T19:00:29.586040Z`, average absolute
  slippage was `13.8203637593029676` bps, and the guardrail is `8` bps.
- Live routeability had zero routeable symbols, five blocked symbols, and three missing symbols.
- Blocked symbols were `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA`; missing symbols were `AMZN`, `GOOGL`, and `ORCL`.
- The top repair candidates were `AAPL` and `NVDA`, both zero-notional.

### Simulation And Quant Evidence

- Simulation `/trading/health` returned `status=ok` operationally, but proof floor remained `repair_only` and capital
  state remained `zero_notional`.
- Simulation routeability had one probing symbol, `NVDA`, seven missing symbols, and zero routeable symbols.
- Simulation blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_incomplete`, and `market_context_stale`.
- Jangar quant health for live account/window returned 144 latest metrics and a fresh latest update during one direct
  read, but stage coverage was empty.
- Torghut's live health payload also observed degraded quant evidence with `quant_metrics_update_missing` or
  `quant_pipeline_stages_missing`, depending on the exact sample.
- Jangar quant health for `TORGHUT_SIM/15m` returned `status=degraded`, zero latest metrics, empty latest store alarm,
  and empty stages.
- The important data-quality finding is not one endpoint state. It is that latest metrics, stage receipts, simulation
  coverage, market context, routeability, and empirical jobs still disagree.

### Source Evidence

- `services/torghut/app/main.py` is 4188 lines and still assembles readiness, health, whitepaper, trading, proof-floor,
  status, and metrics behavior.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4368 lines and remains the highest-risk trading pipeline.
- `services/torghut/app/whitepapers/workflow.py` is 4473 lines and affects startup/runtime risk despite being
  orthogonal to capital admission.
- `services/torghut/app/trading/proof_floor.py`, `route_reacquisition.py`, `revenue_repair.py`, and
  `submission_council.py` already contain the ingredients for pricing repair outcomes.
- The trading package has 127 Python modules and the test suite has 144 `test_*.py` files.
- Existing design artifacts define quant stage cohorts and zero-notional repair packets, but the source does not yet
  contain `quant_stage_cohort`, `evidence_repair_settlement`, `zero_notional_route_repair_packets`, or this
  outcome-priced market reducer.

## Problem

Torghut can now identify repairs, but it still cannot prove which repair is worth doing next.

The current repair ladder says to repair route universe, signal freshness, alpha readiness, execution TCA, market
context, and empirical jobs. That is directionally right and still insufficient. The ladder does not make repairs
compete by after-cost value, does not bind each repair to a Jangar brownout decision, and does not create a capital
shadow swap that estimates what paper/live surface would become eligible if the repair succeeds.

The result is a common failure pattern:

1. A repair job runs and produces some evidence.
2. The global status is still degraded because another proof surface is stale.
3. No one can say whether the repair bought capital option value or just generated more artifacts.
4. The next repair is chosen by urgency, not by measured unblock value.

For the next six months, Torghut needs repair economics, not just repair enumeration.

## Alternatives Considered

### Option A: Refresh All Empirical Jobs First

Pros:

- Empirical services are clearly degraded.
- Refreshing jobs is a direct existing repair class.
- It keeps paper and live capital closed.

Cons:

- It does not fix zero live routeability.
- It does not fill missing simulation symbols.
- It does not make market context fresh.
- It does not create quant stage receipts.
- It may spend runner capacity without knowing whether stale empirical proof is the highest-value blocker.

Decision: reject as the architecture default. Empirical refresh remains a bid inside the selected market.

### Option B: Open Paper Rehearsal From The Simulation `NVDA` Probe

Pros:

- Produces faster paper feedback.
- Uses the one simulation candidate that is already probing.
- Could produce fresh TCA and route observations.

Cons:

- Simulation still has seven missing symbols and empty quant latest metrics.
- Live has zero routeable symbols and stale market context.
- Jangar route-stability escrow holds paper canary.
- Alpha readiness has zero promotion-eligible hypotheses.
- It would confuse repair evidence with capital authority.

Decision: reject. `NVDA` is a repair candidate, not a paper canary authority.

### Option C: Add Outcome-Priced Repair Market And Capital Shadow Swaps

Pros:

- Ranks repairs by measurable after-cost unblock value.
- Keeps live and paper notional at zero while still allowing outcome measurement.
- Binds every repair to Jangar brownout clearing and finite receipt contracts.
- Converts successful repair into a shadow capital option, not an immediate capital grant.

Cons:

- Adds a reducer and status schema.
- Requires before/after proof windows for each repair.
- Some urgent repairs will be held until they can name falsification checks.

Decision: select Option C.

## Architecture

Add `outcome_priced_repair_market` as a pure reducer under `services/torghut/app/trading/`. It should not perform
network calls or database writes. The HTTP assembly layer passes in already gathered proof-floor, route, TCA, quant,
empirical, market-context, alpha-readiness, submission-policy, and Jangar brownout evidence.

Inputs:

- Profitability proof floor
- Route reacquisition book
- Execution TCA summary
- Quant evidence status
- Empirical job status
- Market-context freshness
- Alpha readiness summary
- Live submission gate
- Jangar `repair_outcome_brownout_market`
- Existing zero-notional repair packets, when implemented

`OutcomePricedRepairMarket` fields:

- `market_id`
- `generated_at`
- `account_label`
- `trading_mode`
- `service_revision`
- `capital_state`
- `max_notional`
- `jangar_brownout_market_id`
- `proof_window_ref`
- `bids`
- `clearing_order`
- `blocked_bids`
- `capital_shadow_swaps`
- `decision`: `observe`, `measure_only`, `repair_hold`, `paper_candidate_hold`, or `block`
- `rollback_target`

`OutcomeRepairBid` fields:

- `bid_id`
- `repair_class`
- `target_blocker`
- `symbol`
- `before_ref`
- `required_after_ref`
- `expected_unblock_value`
- `expected_cost`
- `after_cost_unblock_value`
- `proof_age_seconds`
- `route_scope_weight`
- `falsification_check`
- `allowed_by_jangar`
- `max_notional`
- `max_runtime_seconds`
- `max_dispatches`
- `decision`
- `reason_codes`

`CapitalShadowSwap` fields:

- `swap_id`
- `bid_id`
- `from_capital_surface`: `zero_notional`
- `to_shadow_surface`: `paper_rehearsal_candidate`, `paper_canary_candidate`, or `live_micro_candidate`
- `notional_authority`: always `none` until separate gates pass
- `required_receipts`
- `missing_receipts`
- `estimated_capital_option_value`
- `kill_conditions`
- `expires_at`

Repair classes:

- `route_guardrail_reduction`
- `missing_symbol_probe`
- `market_context_refresh`
- `quant_stage_refill`
- `simulation_latest_store_refill`
- `empirical_job_renewal`
- `alpha_readiness_settlement`
- `submission_gate_recheck`

Ranking rule:

```text
after_cost_unblock_value =
  expected_unblock_value
  * proof_age_multiplier
  * route_scope_weight
  * jangar_admissibility_weight
  - expected_cost
```

The exact weights belong in implementation, but the contract is fixed: a repair with no blocker, no after proof, no
falsification check, or nonzero notional cannot rank above a bounded zero-notional repair with a clear after proof.

## Trading Hypotheses

- `AAPL` is the first live route guardrail repair because it has the lowest average absolute slippage among blocked
  live symbols, but it still exceeds the 8 bps guardrail and must remain zero-notional.
- `NVDA` is the first paired live/simulation repair because live has rich blocked TCA evidence and simulation already
  has a probing path. Success means route and proof coherence, not capital admission.
- `AMZN`, `GOOGL`, and `ORCL` are missing-symbol probe repairs. Success means moving from missing to probing with
  zero notional and fresh context.
- `TORGHUT_SIM/15m` quant latest store refill outranks low-scope proof churn because simulation has zero latest
  metrics and no stage receipts.
- Empirical job renewal is capital-relevant only when it closes stale job receipts for a candidate that also has route,
  market-context, quant, and alpha receipts.

## Engineer Implementation Scope

1. Add the pure reducer and typed payload model under `services/torghut/app/trading/`.
2. Expose `outcome_priced_repair_market` and `capital_shadow_swaps` from `/trading/status`, `/trading/health`, and
   `/trading/autonomy`.
3. Consume Jangar brownout market decisions when available; otherwise default to `repair_hold`.
4. Add revenue-repair digest integration so ranked bids are visible to existing repair summaries.
5. Add unit tests for live zero-routeable state, simulation probing state, empty simulation quant store, stale market
   context, stale empirical jobs, nonzero notional rejection, missing after proof rejection, and Jangar brownout hold.
6. Add API contract tests proving paper/live notional remains zero even when a capital shadow swap is emitted.

## Validation Gates

Local engineer gates:

- `uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_route_reacquisition.py`
- `uv run --frozen pytest tests/test_revenue_repair.py -k outcome`
- `uv run --frozen pytest tests/test_trading_api.py -k outcome_priced_repair_market`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Runtime deployer gates:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.outcome_priced_repair_market'`
- `curl -fsS http://torghut-sim.torghut.svc.cluster.local/trading/status | jq '.outcome_priced_repair_market'`
- Live payload reports `capital_state=zero_notional` and no bid with `max_notional` other than `0`.
- At least one live route repair bid targets `execution_tca_route_universe_empty`.
- At least one simulation repair bid targets `quant_latest_metrics_empty` or `execution_tca_route_universe_incomplete`.
- No `capital_shadow_swap` grants paper or live notional.
- Jangar brownout market decision is cited before any measurement job is admitted.

## Rollout Plan

1. Ship the reducer in shadow mode and expose it from status/health/autonomy.
2. Keep existing proof floor and submission gates authoritative.
3. Compare the ranked bid order with current repair ladder output for one full market session.
4. Let deployer use the payload to choose zero-notional measurement jobs only.
5. After two successful before/after repair receipts, allow paper rehearsal planning, not paper execution.
6. Require separate Jangar stage-freeze clearing, source rollout truth, routeability, quant stage, market context,
   empirical, alpha, and submission receipts before paper canary or live micro canary.

## Rollback Plan

- Hide `outcome_priced_repair_market` and `capital_shadow_swaps` from deployer enforcement while keeping proof floor
  authoritative.
- Fall back to the existing repair ladder and route reacquisition book.
- Force all capital shadow swaps to `notional_authority=none`.
- Treat missing Jangar brownout market evidence as `repair_hold`.
- Keep live submit disabled and `max_notional=0`.

## Risks

- The market can overfit to the scoring function. Mitigation: require falsification checks and before/after proof
  windows, not just a high score.
- Repairs can become too slow. Mitigation: allow measurement during brownout for zero-notional repairs with clear
  receipts.
- Simulation repairs can look stronger than live evidence. Mitigation: shadow swaps never grant notional and must cite
  live route, context, empirical, and alpha receipts before paper/live gates move.
- Jangar evidence can be missing. Mitigation: default to `repair_hold` and keep existing proof floor behavior.

## Handoff To Engineer And Deployer

Engineer should implement the reducer as pure logic and keep it out of the scheduler hot path until tests prove the
contract. Do not add more branching to `main.py` beyond assembly. The reducer should receive already built payloads
and return one deterministic market object.

Deployer should use this design to select the next zero-notional measurement job, not to open capital. Paper and live
remain closed until the repair market produces before/after receipts, Jangar clears the stage brownout, and Torghut
proof floor exits `repair_only`.
