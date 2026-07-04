# 94. Torghut Session Edge Ledger and Cost-Aware Capital Allocator (2026-05-05)

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

Torghut should add a **SessionEdgeLedger** and a **CostAwareCapitalAllocator** before any paper or live capital
reentry.

The evidence-priced hypothesis market tells us which proof is valuable. It still needs a stricter profitability
boundary: session-by-session realized edge after slippage, signal lag, feature availability, route SLO, and repair
capacity. A hypothesis with a 6 to 10 bps gross edge cannot receive capital while the observed absolute slippage proxy
is hundreds of bps and signal lag is well beyond the manifest entry contract.

I am choosing a cost-aware ledger that records every hypothesis quote against the market session that produced it. The
allocator can fund zero-notional repair when the ledger says the repair has positive option value. It cannot allocate
paper or live capital unless the session edge ledger proves a fresh, post-cost edge and the companion Jangar capacity
lease says the proof route can be trusted.

The tradeoff is that this will delay new alpha deployment. That is the right delay. Profitability is not blocked by a
shortage of strategy names; it is blocked by stale empirical proof, route timeouts, signal lag, missing features, and
unexplained execution cost.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Runtime Evidence

- Torghut live revision `torghut-00223` and sim revision `torghut-sim-00304` were Running and returned HTTP 200 for
  `/healthz`.
- Torghut warning events showed latest sim revision creation failure, recent live and sim readiness timeouts, repeated
  ClickHouse PodDisruptionBudget ambiguity, options catalog startup/readiness churn, and WebSocket options readiness
  HTTP 503.
- Jangar `/ready` returned HTTP 200, but execution trust was degraded and serving admission was only `degrade`.
- Jangar `swarm_plan`, `swarm_implement`, and `swarm_verify` admission passports were `hold` because of
  `execution_trust_degraded`.
- Jangar status returned HTTP 200 in 3.319s once with dependency quorum `block`, then a later status sample timed out
  after 12 seconds.
- Jangar quant-health timed out after 30 seconds for both live and sim.

### Torghut Route Evidence

- Live `/readyz` returned HTTP 503 in 5.000s.
- Live `/trading/health` returned HTTP 503 in 3.838s. Live submission was blocked by `simple_submit_disabled`, capital
  stayed `shadow`, and live quant evidence was `quant_health_not_configured`.
- Sim `/trading/health` returned HTTP 200 in 9.009s, but quant evidence was `quant_health_fetch_failed` and the source
  URL pointed to the timed-out Jangar quant-health route.
- Live `/trading/status` returned HTTP 200 in 4.615s, with `last_decision_at=2026-05-04T17:25:57.901670Z`.
- The second live status sample reported `jangar_status_fetch_failed` because the control-plane status request timed
  out.
- `/trading/empirical-jobs` returned HTTP 200 but `ready=false`, `status=degraded`, `authority=blocked`, and stale
  March 21 empirical jobs.

### Database and Data Evidence

- `/db-check` returned HTTP 200 with `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, one current head, no duplicate revisions, no orphan parents, and
  lineage-ready known parent-fork warnings.
- Direct CNPG SQL was blocked by RBAC, and listing Torghut secrets for ClickHouse credentials was forbidden.
- ClickHouse direct unauthenticated HTTP returned `REQUIRED_PASSWORD`; database assessment used exported metrics and
  service routes instead.
- ClickHouse guardrails reported both replicas up, no read-only table alarm, disk free ratio above 96%, max signal and
  microbar timestamps at `2026-05-05T20:59:07Z`, and last successful scrape at `2026-05-05T21:13:00Z`.
- Microbar freshness had 161 low-memory/fallback freshness queries, which should be priced as proof cost, not ignored.
- Options catalog `/readyz` returned ready but had `last_success_ts=null`; options enricher returned ready while
  carrying `snapshot_cycle_failed` from a canceled active-contract count query.

### Source Architecture Evidence

- Hypothesis manifests are source-controlled under `services/torghut/config/trading/hypotheses`.
- Current gross-edge assumptions are 6 bps for `H-CONT-01`, 10 bps for `H-MICRO-01`, and 8 bps for `H-REV-01`.
- The same manifests require signal lag under 90 seconds, feature rows, recent drift/evidence checks, dependency
  quorum `allow`, and slippage budgets of 8 to 12 bps before promotion.
- Live status reported all three hypotheses at capital multiplier `0`; `H-CONT-01` and `H-REV-01` were shadow,
  `H-MICRO-01` was blocked, and all three required rollback.
- Runtime observations showed signal lag around 16 minutes, zero feature batch rows, zero drift checks, 13,775 TCA
  orders, average absolute slippage of `568.6138848199565249` bps, and a post-cost proxy that needs reconciliation
  before it can be trusted for capital.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` still short-circuits simple live mode before the
  proof-aware submission council when pipeline mode is `simple`.
- `services/torghut/app/trading/submission_council.py` already has the right proof vocabulary: dependency quorum,
  empirical jobs, quant evidence, promotion certificates, capital stage, and reason codes.
- Torghut has 152 Python test files, but the risk is concentrated in `main.py` at 3,981 lines and
  `submission_council.py` at 1,196 lines. The allocator must be pure and fixture-driven before route wiring.

## Problem

The current system is broker-safe but not yet profit-competent.

The evidence-priced market introduced a way to value proof debt. The current evidence says the next missing object is a
ledger that can answer a harder question: did this hypothesis earn positive edge in this session after the actual cost
of getting from signal to fill?

Without that ledger, Torghut can make three unsafe mistakes:

1. treat gross-edge manifests as capital evidence when signal lag and slippage exceed the entry contract;
2. fund empirical refresh without knowing whether it unlocks cost-adjusted profit or only fresher losses;
3. let a paper account look healthy because it is non-live while quant-health, Jangar status, and route SLO are
   unavailable.

The goal is not to make capital harder forever. The goal is to make every unit of proof and capital buy measurable
post-cost edge.

## Alternatives Considered

### Option A: Keep Capital Frozen Until Every Gate Is Green

Continue to hold paper and live capital until empirical jobs, quant-health, feature rows, signal lag, route SLO, and
Jangar dependency quorum are all healthy.

Pros:

- Strong safety.
- Easy deployer rule.
- Avoids capital exposure during ambiguous proof.

Cons:

- Does not rank repairs by expected profit.
- Does not explain whether slippage or signal lag is the dominant blocker.
- Leaves March empirical artifacts stale until a human picks the next repair.
- Does not teach the allocator which hypothesis would deserve capital first.

Decision: keep as emergency posture only.

### Option B: Prioritize New Alpha or Options Strategies

Build new microstructure or options hypotheses and use the current shadow state for rapid iteration.

Pros:

- Higher apparent upside.
- Uses existing strategy and hypothesis scaffolding.
- Can run zero-notional quickly.

Cons:

- Ignores current cost evidence.
- Options readiness is not enough when catalog success is null and enricher carries query-canceled evidence.
- Adds proof load while Jangar routes and workflow capacity are already degraded.
- Risks optimizing against stale March empirical proof.

Decision: reject for the next architecture lane.

### Option C: SessionEdgeLedger and CostAwareCapitalAllocator

Record session-level signal, feature, route, empirical, TCA, and capacity evidence for each hypothesis. Allocate repair,
paper, and live capital only from cost-adjusted quotes with expiry and rollback triggers.

Pros:

- Converts proof and repair into a profit-ranked queue.
- Makes slippage and signal lag first-class capital blockers.
- Lets zero-notional work proceed when it has positive repair option value.
- Prevents non-live paper health from masking missing quant-health and route SLO.
- Aligns Torghut capital with the companion Jangar proof capacity lease.

Cons:

- Adds policy state and an allocator that must be explainable.
- Requires careful session attribution so stale data does not contaminate fresh quotes.
- May keep capital at zero longer while cost accounting is repaired.

Decision: select Option C.

## Chosen Architecture

### SessionEdgeLedger

```text
session_edge_ledger
  ledger_id
  market_session_id
  hypothesis_id
  account_scope
  signal_max_lag_seconds
  feature_rows_total
  drift_checks_total
  empirical_jobs_ref
  quant_health_ref
  jangar_route_slo_ref
  proof_capacity_lease_ref
  tca_order_count
  avg_abs_slippage_bps
  expected_gross_edge_bps
  realized_gross_edge_bps
  realized_net_edge_bps
  cost_drag_bps
  decision                 # hold, repair, replay, paper_probe, live_probe, scale
  reason_codes
  observed_at
  fresh_until
```

Rules:

- A ledger row is session-scoped. It cannot be reused across market sessions without an explicit replay receipt.
- Signal lag above the manifest threshold holds paper/live and recommends repair.
- Slippage above the manifest budget holds paper/live even when gross-edge evidence is positive.
- A missing Jangar route SLO or expired proof capacity lease holds capital and can still recommend zero-notional
  repair.
- Post-cost proxies are informational until reconciled against TCA and fill attribution.

### CostAwareCapitalAllocator

```text
cost_adjusted_capital_quote
  quote_id
  hypothesis_id
  market_session_id
  expected_gross_edge_bps
  expected_cost_bps
  expected_net_edge_bps
  proof_debt_score
  data_quality_score
  capacity_cost_score
  repair_option_value
  max_stage               # zero_notional, paper_probe, paper_canary, live_probe, scaled_live
  recommended_action
  max_notional
  rollback_triggers
  reason_codes
  expires_at
```

Rules:

- `zero_notional` can be allocated for repair when repair option value is positive and Jangar grants a capacity lease.
- `paper_probe` requires fresh empirical jobs, signal lag under threshold, feature rows present, quant-health reachable,
  route SLO healthy, and positive expected net edge after cost.
- `live_probe` requires two clean paper sessions with positive realized net edge, cost inside budget, rollback readiness,
  and explicit broker toggles.
- A quote with positive gross edge but negative or unknown net edge receives repair priority, not capital.

### Capacity-Aware Repair Book

```text
repair_auction_order
  order_id
  blocker
  hypothesis_id
  expected_unlock_value
  expected_capacity_cost
  required_proof_capacity_lease
  target_receipt
  max_runtime_minutes
  max_database_ms
  max_route_ms
  priority
  status
```

Initial repair priorities from this evidence pass:

- Clear Jangar quant-health timeout and route SLO for live and sim.
- Refresh empirical jobs from March 21 artifacts to a current dataset snapshot.
- Repair signal lag and feature rows before any paper probe.
- Reconcile TCA slippage against hypothesis budgets before trusting the post-cost proxy.
- Repair options catalog/enricher query shape before options hypotheses can leave hold.

## Measurable Hypotheses

- `H-CONT-01`: gross edge 6 bps, slippage budget 12 bps. Next action is `repair` until signal lag is below 90 seconds,
  feature rows are present, empirical jobs are fresh, and realized net edge is positive in at least one clean session.
- `H-MICRO-01`: gross edge 10 bps, slippage budget 8 bps. Next action is `repair_only`; it needs microstructure feature
  coverage, drift checks, and a cost ledger proving that execution cost does not consume the expected edge.
- `H-REV-01`: gross edge 8 bps, slippage budget 12 bps. Next action is `repair` for market-context freshness, signal
  lag, and Jangar dependency quorum before any paper probe.
- Options hypotheses remain `hold` until catalog/enricher cycles have fresh success, options feature rows are populated,
  and route/database cost is inside the companion Jangar capacity lease.

## Engineer Scope

1. Add pure builders for `SessionEdgeLedger`, `CostAwareCapitalAllocator`, and `repair_auction_order`.
2. Build ledger inputs from cached projections: hypothesis runtime status, empirical jobs, quant evidence, Jangar route
   SLO, proof capacity leases, TCA, signal lag, feature rows, and schema status.
3. Route simple live and non-live paper gates through the cost-aware allocator in shadow mode before changing behavior.
4. Add explicit policy weights for proof debt, data quality, cost drag, and capacity cost in source control.
5. Emit per-hypothesis ledger rows and quotes in `/trading/status` without deep request-time database scans.
6. Keep paper/live capital disabled until validation proves the allocator never allows stale empirical proof, missing
   quant-health, or cost-above-budget sessions.

## Validation Gates

- Unit test: signal lag above manifest threshold recommends `repair`, not `paper_probe`.
- Unit test: slippage above hypothesis budget holds paper/live even when gross edge is positive.
- Unit test: stale empirical jobs recommend empirical refresh and set max stage `zero_notional`.
- Unit test: missing Jangar route SLO or expired proof capacity lease holds capital but can allow leased repair.
- Unit test: non-live paper mode cannot bypass quant-health and cost-aware allocator in shadow results.
- Integration test: `/trading/status` includes session edge ledger rows, capital quotes, expiry, and reason codes from
  cached projections.
- Integration test: `/trading/health` fails closed for paper/live when quant-health times out or route SLO is held.
- Deployer smoke: after one market session, each hypothesis has a ledger row, cost quote, recommended action, and
  rollback trigger set.

## Rollout Plan

1. Ship ledger and allocator builders with fixture coverage.
2. Project shadow ledger and capital quotes into `/trading/status`.
3. Compare allocator recommendations to current submission-council blocks for one market session.
4. Enforce repair ranking for zero-notional work only when Jangar grants proof capacity leases.
5. Route paper gate decisions through the allocator while keeping live disabled.
6. Enable paper probes only after two clean sessions of shadow recommendations and deployer smoke.
7. Keep live disabled until paper sessions prove positive realized net edge, cost inside budget, route SLO healthy, and
   rollback readiness.

## Rollback Plan

- Disable allocator enforcement and keep ledger projection.
- If ledger projection pressures routes, serve only the latest cached ledger row.
- If cost attribution is wrong, hold paper/live and continue zero-notional repair under explicit leases.
- If Jangar route SLO is unavailable, fail closed for paper/live and allow only local repair with no broker orders.
- If simple lane routing regresses, keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and retain the existing submission block.

## Handoff Contract

Engineer acceptance:

- Ledger and allocator logic must be pure and tested before route wiring.
- Every capital quote must expose gross edge, cost estimate, net edge, proof debt, capacity cost, expiry, and reason
  codes.
- Paper/live cannot be allowed from stale empirical jobs, missing quant-health, route SLO hold, or slippage above
  budget.

Deployer acceptance:

- Before paper reentry, verify fresh empirical jobs, healthy Jangar route SLO, a current proof capacity lease, signal
  lag below manifest threshold, feature rows present, and a positive cost-adjusted quote.
- Before live reentry, require two clean paper sessions, positive realized net edge, cost inside budget, rollback
  readiness, and live broker toggles explicitly enabled.
- A green `/healthz`, `/db-check`, or non-live paper gate is necessary evidence, not sufficient authority.

Open risks:

- Cost attribution can be noisy until signal, order, and fill lineage are reconciled. The first implementation should
  expose every term and stay in shadow.
- A strict cost gate may keep all hypotheses at zero notional longer. That is acceptable until repair work proves
  positive expected net edge.
- Options profitability remains speculative until options catalog and feature rows produce current successful cycles.
