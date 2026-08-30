# 131. Torghut Active Profit Inventory And Quant Carry Fuses (2026-05-06)

Status: Accepted for engineer and deployer handoff

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

I am selecting an **active profit inventory with quant carry fuses** for Torghut capital reentry.

The current Torghut runtime is available enough to observe, but not capital-ready. At `2026-05-06T18:27Z`, the live
Torghut revision, sim revision, Postgres, ClickHouse replicas, Keeper, TA, sim TA, options catalog/enricher, websocket
pods, and guardrail exporters were running. ClickHouse pods were ready. Torghut Postgres was reachable through the app
role and schema-current at Alembic head `0029_whitepaper_embedding_dimension_4096`.

The profit inventory is thin. The Torghut app database sample showed `17` estimated `trade_decisions`, `1`
`trade_cursor`, `0` `executions`, and `0` `strategy_hypotheses`. Jangar's Torghut control-plane schema had about
`50.8M` `quant_pipeline_health` rows and `2.1M` `quant_metrics_series` rows, but zero `simulation_runs`,
`simulation_artifacts`, `simulation_campaigns`, `simulation_campaign_runs`, `simulation_lane_leases`, and
`dataset_cache` rows. The cluster is doing Torghut work, but the durable profit inventory needed to rank and admit
capital is not yet present.

The selected design makes Torghut consume Jangar activation products and maintain one active profit inventory per
hypothesis, account, strategy, and window. Quant data is useful only when it carries a current inventory item with a
consumer, a stage, a settlement target, and bounded cost. Otherwise it opens a quant carry fuse and can support
zero-notional observe or repair, not paper or live capital.

The tradeoff is slower paper reentry when core dependencies look healthy. I accept that. A running cluster plus a large
quant cache is not proof of an actionable edge. Torghut should spend capital only when it can name the active profit
inventory item it is updating and the Jangar activation product that says the producer path is alive.

## Runtime Objective And Success Metrics

This contract increases profitability by preventing data volume from masquerading as profit evidence.

Success means:

- Every paper or live capital decision cites an `active_profit_inventory_item`.
- Every inventory item cites Jangar activation products for the producer path it depends on.
- Large quant tables must be tied to active hypotheses, simulation runs, decision rows, or settlement receipts.
- Zero-notional observe and repair remain available while inventory is empty.
- Paper canary and live micro-canary remain impossible when inventory is empty, stale, contradictory, or too costly.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, or runtime objects.

### Cluster And Runtime Evidence

- Torghut namespace phase counts were `Running=27` and `Succeeded=2`.
- Live `torghut-00241-deployment-d899967d5-hhh6x` was `2/2 Running`.
- Sim `torghut-sim-00339-deployment-6f89d5cdf-hm64m` was `2/2 Running`.
- `torghut-db-1`, both ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog, options enricher,
  websockets, guardrail exporters, Alloy, and Symphony were running.
- Recent Torghut events showed current sim runtime-ready and activity analysis success, one teardown-clean failure,
  startup/readiness warm-up during revision replacement, and repeated ClickHouse multiple-PDB warnings.
- Listing Argo AnalysisRuns was forbidden to the agents service account, so the design must use service-owned products
  and route projections for audit.

### Database And Data Evidence

- Torghut direct read-only SQL used the `torghut-db-app` secret and connected as `torghut_app`.
- Torghut public schema had `71` tables and Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Sampled table statistics showed `trade_decisions=17`, `trade_cursor=1`, `executions=0`, and
  `strategy_hypotheses=0`.
- Jangar direct read-only SQL showed the Torghut control-plane cache in the Jangar database:
  `quant_pipeline_health` estimated `50838708` rows, `quant_metrics_series` estimated `2149704` rows, and
  `quant_metrics_latest` estimated `4032` rows.
- Jangar's Torghut simulation-control tables estimated zero rows for datasets, runs, artifacts, campaigns, campaign
  runs, and lane leases.
- The Jangar app database was migrated through
  `20260505_torghut_quant_pipeline_health_window_index`.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already combines dependency quorum, empirical jobs, Jangar
  quant health, market context, promotion policy, and capital stage.
- `services/torghut/app/trading/hypotheses.py` already represents hypothesis state, capital stage, rollback
  requirement, promotion eligibility, and dependency capability.
- `services/torghut/app/trading/empirical_jobs.py` already validates proof truthfulness, lineage, candidate ids,
  dataset refs, artifact refs, and authority eligibility.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` and the Torghut control-plane migrations own the large
  quant cache path. That path needs cost-aware consumers, not broader status scans.
- `services/jangar/src/server/torghut-simulation-control-plane.ts` defines simulation run, lane, and cache concepts,
  but the live Jangar database sample shows those tables empty for the current active sim posture.

## Problem

Torghut is vulnerable to a profitable-looking false positive: healthy services and large data tables without active
profit inventory.

The current evidence has four gaps:

1. **No active hypothesis rows.** `strategy_hypotheses` is empty in the sampled Torghut database.
2. **No execution settlement.** `executions` is empty and `trade_decisions` is small, so paper/live widening cannot
   rely on recent realized behavior.
3. **No Jangar simulation inventory.** Active sim pods exist, but Jangar simulation run and lane lease tables are empty.
4. **High quant carry cost.** Large quant health and series tables exist without a matching active profit consumer in
   the sampled inventory.

The answer is not to stop Torghut work. The answer is to separate observe and repair from capital admission.

## Alternatives Considered

### Option A: Reopen Paper When Core Dependencies Are Healthy

Pros:

- Fastest route to fresh paper decisions.
- Uses the currently healthy runtime.
- Keeps implementation local to submission council thresholds.

Cons:

- Ignores empty executions and hypothesis inventory.
- Ignores missing Jangar simulation rows.
- Treats large quant tables as readiness rather than cost.
- Repeats the old route-health versus capital-readiness confusion.

Decision: reject.

### Option B: Freeze All Capital Until Every Inventory Surface Is Fully Populated

Pros:

- Strong capital safety.
- Easy to explain.
- Avoids accidental live notional.

Cons:

- Blocks zero-notional learning.
- Does not prioritize which inventory gap to repair first.
- Wastes the running sim and quant infrastructure.
- Can trap Torghut in shadow even when one small producer gap is blocking paper.

Decision: reject.

### Option C: Active Profit Inventory With Quant Carry Fuses

Pros:

- Allows observe and repair while preventing unbacked paper/live notional.
- Turns large data tables into cost-aware inventory inputs.
- Makes simulation rows and hypothesis rows explicit capital prerequisites.
- Lets Jangar activation products decide whether the producer path is alive.

Cons:

- Adds inventory reducers and route fields.
- Requires careful calibration so small but valid paper inventory is not treated as empty.
- Depends on Jangar activation products for full enforcement.

Decision: select Option C.

## Architecture

Torghut emits active inventory items.

```text
active_profit_inventory_item
  inventory_id
  generated_at
  hypothesis_id
  strategy_id
  account_label
  window
  capital_stage
  source_activation_product_ids
  simulation_run_ref
  dataset_ref
  latest_trade_decision_ref
  latest_execution_ref
  empirical_proof_refs
  quant_product_refs
  market_context_refs
  row_cost_estimate
  expected_profit_carry_bps
  confidence
  decision       # observe_only, repair_only, paper_allowed, live_micro_allowed, live_scale_allowed, hold, block
  fuse_refs
  rollback_target
```

Quant carry fuses:

- `inventory_empty`: no active hypothesis, decision, execution, or simulation item backs the capital request.
- `simulation_untracked`: sim pods are active but Jangar simulation inventory is empty.
- `execution_settlement_missing`: no recent execution settlement exists for the account/window.
- `quant_cost_unbounded`: large quant tables are queried without a bounded latest, rollup, or active consumer.
- `activation_product_missing`: Jangar cannot prove the required producer path is active.
- `profit_consumer_missing`: an evidence product has no hypothesis, strategy, or account consumer.

Capital stage rules:

- `shadow_observe`: allowed with runtime health, active activation products, and max notional `0`.
- `repair_trade`: allowed only for zero-notional or simulation repair while a named fuse is open.
- `paper_canary`: requires active inventory, tracked simulation or paper run, scoped quant, empirical proof, and no
  unbounded quant-cost fuse.
- `live_micro_canary`: requires paper settlement, execution settlement, live policy, TCA, and LLM governance products.
- `live_scale`: requires post-cost live micro evidence and deployer-approved material action receipts.

## Measurable Trading Hypotheses

H-API-01, inventory-backed paper beats route-health paper:

- Hypothesis: paper canary admitted only with active inventory produces fewer rollback-required decisions than canary
  admitted from route health alone.
- Measurement: rollback-required decisions per paper window, paper decision count, execution settlement count, and
  post-cost return.
- Guardrail: paper max notional is `0` while `inventory_empty` is open.

H-API-02, simulation tracking predicts profitable repair:

- Hypothesis: requiring Jangar simulation run and lane lease inventory before paper reduces false repair work by at
  least `50%`.
- Measurement: sim run creation to paper eligibility latency, failed repair count, artifact settlement count, and
  dataset reuse rate.
- Guardrail: active sim pods without Jangar run inventory permit only observe and repair.

H-API-03, quant carry fuses reduce data cost without reducing signal freshness:

- Hypothesis: bounding quant reads by active inventory and latest products reduces control-plane query pressure while
  preserving strategy freshness.
- Measurement: quant route latency, row scan estimates, latest metric freshness, and open quant alerts.
- Guardrail: no broad scan of health or series tables is allowed for capital admission.

H-API-04, execution settlement is a live-only unlock:

- Hypothesis: missing execution settlement should not block zero-notional observe, but must block live micro-canary.
- Measurement: shadow decisions continue, paper decisions settle, and live notional remains `0` until execution and TCA
  products are current.
- Guardrail: live micro-canary is blocked when `execution_settlement_missing` is open.

## Implementation Scope

Engineer stage:

- Add pure Torghut reducers for active profit inventory and quant carry fuses.
- Extend submission council or trading health payloads with shadow inventory items and fuse summaries.
- Consume Jangar activation products when available; before that, build shadow adapter products from existing route
  payloads and label them as shadow-only.
- Add fixtures for current evidence: zero executions, small decision inventory, no strategy hypotheses, active sim
  pods, empty Jangar simulation inventory, and large quant cache tables.
- Do not change broker adapters, live submission flags, or trading notional in the first implementation PR.

Jangar dependency:

- Jangar publishes activation inventory products for Torghut quant cache, simulation control-plane, runtime health,
  and material evidence products.
- Jangar exposes bounded data-cost summaries, not full quant table scans.

## Validation Gates

Local gates:

- `uv run --frozen pytest tests/test_submission_council.py tests/test_trading_api.py`
- `uv run --frozen pytest tests/test_empirical_jobs.py tests/test_strategy_hypothesis_governance_migration.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Behavior gates:

- Empty hypothesis inventory opens `inventory_empty` and blocks paper/live.
- Active sim evidence without Jangar simulation rows opens `simulation_untracked`.
- Large quant cache stats without active consumer opens `quant_cost_unbounded`.
- Zero-notional observe stays allowed while fuses are open.
- Live micro-canary remains blocked without execution settlement and Jangar activation products.

Read-only runtime gates:

- Torghut `/trading/health` names active inventory ids or blocking fuse ids.
- Jangar status names activation products consumed by Torghut.
- Deployer evidence includes current Torghut Alembic head, ClickHouse readiness, and bounded Jangar quant-cache
  statistics.

## Rollout Plan

Phase 0, fixtures:

- Land reducers and tests only.
- Keep capital decisions unchanged.

Phase 1, shadow inventory:

- Emit inventory and fuse summaries from trading health/status.
- Compare shadow decisions against current submission council output.

Phase 2, paper enforcement:

- Enforce inventory and quant carry fuses for paper canary.
- Keep live submission blocked by existing policy and notional `0`.

Phase 3, live micro-canary:

- Enforce execution settlement, LLM governance, TCA, live policy, and Jangar activation products.
- Widen only with Jangar material action receipts and deployer signoff.

## Rollback

- Disable inventory enforcement and keep shadow inventory visible.
- Keep `simple_submit_disabled` and existing live-submission brakes unchanged.
- Force paper notional to `0` if inventory, quant carry, or activation products regress.
- Do not replace missing inventory with direct database, ClickHouse, or broker inspection.
- Preserve emitted inventory ids and fuse ids for audit.

## Risks

- Inventory can be too strict if low-frequency strategies legitimately have sparse decisions or executions.
- Quant cost estimates can be stale if PostgreSQL statistics lag actual table size.
- Shadow adapter products can drift from Jangar product schema if the Jangar implementation changes independently.
- Sim tracking can block valid paper repair if Jangar simulation-control tables are intentionally unused for a lane.
- Expected profit carry can be overfit unless it is tied to actual post-cost decisions and settlement receipts.

## Handoff To Engineer

Implement pure reducers and shadow route payloads first. Use the current evidence as fixtures and prove the reducer
keeps observe/repair open while blocking paper/live when active inventory is empty or quant carry is unbounded.

Acceptance gates:

- No broker adapter, live flag, or notional behavior changes in the first PR.
- Tests cover all current fuse cases.
- `/trading/health` can show inventory ids and fuses without requiring database exec.
- Jangar activation products are consumed by id once available.

## Handoff To Deployer

Deploy shadow mode first. Do not enable paper enforcement until inventory ids, Jangar activation product ids, and
blocking fuse ids are visible in the same payload. Keep live disabled until execution settlement, TCA, LLM governance,
and material action receipts are all current.

Rollback gate:

- If paper or live actions move without an active inventory id, disable enforcement immediately.
- If quant carry fuses are missing while large quant tables are queried, return to shadow and open a Jangar repair item
  for bounded data-cost projection.
