# 82. Torghut Order Admission Warrants and Replay Capital Auction

Status: Accepted for implementation planning

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

Torghut should stop treating a route-local live submission gate as the final authority for broker orders. I am choosing
a route-independent `OrderAdmissionWarrant` and a replay-backed `ReplayCapitalAuction` because the live system has a
specific false-positive shape: the live service is healthy and reports `live_submission_gate.allowed: true`, while every
loaded hypothesis is shadow or blocked, all three hypotheses require rollback, Jangar dependency quorum blocks on stale
empirical proof, signal continuity is in an actionable source-fault state, and realized execution data is stale.

The selected architecture moves the hard capital check to the broker boundary. Any non-shadow order must carry a
short-lived warrant minted from one settled proof cut: Jangar rollout settlement, Torghut capital proof clock,
market-state freshness, empirical job freshness, hypothesis runtime state, TCA budget, replay or shadow validation, and
an explicit account/window/symbol budget. Routes may still report liveness, schedulers may still observe, and repair
jobs may still run, but the broker adapter rejects live orders without a valid warrant.

The tradeoff is extra machinery on the hottest path. That is acceptable. The current contradiction proves that a status
route can drift from economic authority; a broker-bound warrant makes that drift non-actionable.

## Runtime Inputs and Success Metrics

The requested base is `main`, the head is `codex/swarm-torghut-quant-discover`, and the stage is discover for the
`torghut-quant` swarm. Success means the next engineer and deployer can implement and validate one contract that:

- prevents non-shadow broker submission when proof clocks disagree;
- preserves read-only serving, observe, shadow, repair, and verify work during degraded control-plane windows;
- defines measurable profitability hypotheses instead of generic readiness language;
- gives deployers exact smoke, rollout, and rollback gates.

All evidence below was collected read-only from Kubernetes, service routes, source, and databases.

## Evidence Captured

### Cluster, Rollout, and Event State

- Torghut live is serving through `torghut-00213`; `/healthz`, `/readyz`, `/db-check`, `/trading/health`, and
  `/trading/status` return HTTP 200.
- The direct sim revision route `torghut-sim-00292` returns `/readyz` HTTP 200, but the `torghut-sim` service route
  times out and direct `/trading/status` also times out from this runtime.
- `torghut-ws` and `torghut-ws-options` pods are `0/1 Running` with recent restarts, and namespace events show
  readiness 503s, liveness restarts, and scheduling pressure from pod count and memory constraints.
- Agents and Jangar are serving after rollout churn, but old scheduled jobs still show `ImagePullBackOff` for promoted
  Jangar images. Recent events include image-pull failures, readiness probe timeouts, failed mounts, and preemption.
- Jangar `/ready` is HTTP 200, but execution trust remains degraded and control-plane status blocks dependency quorum
  on `empirical_jobs_degraded`. This is a serving control plane, not a capital-clear control plane.

### Route and Trading State

- Torghut `/trading/status` reports `mode: live`, `execution_lane: simple`, `kill_switch_enabled: false`, and
  `live_submission_gate.allowed: true` with reason `ready`.
- The same payload reports `promotion_eligible_total: 0`, `rollback_required_total: 3`, and capital multiplier `0` for
  all three hypotheses.
- `H-CONT-01` and `H-REV-01` are shadow; `H-MICRO-01` is blocked. Each carries `jangar_dependency_block` and
  `signal_lag_exceeded`; `H-MICRO-01` also has missing feature and drift checks, and `H-REV-01` has stale market
  context.
- Empirical jobs are stale from `2026-03-21`: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` all report `job_stale`.
- Signal continuity is an active actionable source fault during the market session. The route reports
  `signal_lag_seconds` around `3000`, far above the current hypothesis entry budgets of 90 seconds.
- TCA is not in a promotable cost envelope. The live status reports `order_count: 13775`,
  `avg_abs_slippage_bps: 568.6138848199565249`, and no expected-shortfall coverage sample.

### Source Architecture and Test Surface

- `services/torghut/app/trading/submission_council.py::build_live_submission_gate_payload` is already proof-aware. It
  blocks live submission when promotion eligibility is absent, empirical jobs are not ready, dependency quorum is not
  `allow`, required quant evidence is not ready, or promotion certificate evidence is missing.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` bypasses that proof-aware helper when
  `TRADING_PIPELINE_MODE=simple`. In live mode it checks toggles, kill switch, simple-submit enablement, and emergency
  stop, then returns `allowed: true`, `capital_stage: live`, `dependency_quorum_decision: informational_only`, and
  `empirical_jobs_ready: null` when those toggles are clear.
- The source has useful primitives but no hard broker-bound proof object: `main.py` is about 4000 lines,
  `trading/scheduler/pipeline.py` is over 4200 lines, `trading/research_sleeves.py` is over 5200 lines,
  `trading/autonomy/lane.py` is over 7300 lines, and `trading/autonomy/policy_checks.py` is over 6000 lines.
- Tests cover many local gates, including submission council, scheduler safety, autonomy, quant readiness, simulation
  parity, and profitability evidence. The missing regression is route independence: no test proves the broker adapter
  rejects a non-shadow simple-lane order when the status route says ready but proof clocks block.

### Database, Data Quality, and Freshness

- Torghut Postgres is reachable over TCP with schema head `0029_whitepaper_embedding_dimension_4096`.
- `trade_decisions` has 147606 rows and a latest `created_at` on `2026-05-04`, but executions are stale: `executions`
  has 13778 rows with latest `created_at` on `2026-04-02` and latest `last_update_at` on `2026-04-03`.
- `execution_order_events` has 0 rows, which means order-feed event continuity is not available as an independent
  warrant input yet.
- Research and promotion proof tables are thin or empty: `research_candidates`, `research_fold_metrics`,
  `research_stress_metrics`, `research_promotions`, `strategy_promotion_decisions`, `vnext_promotion_decisions`,
  `research_attempts`, `research_validation_tests`, `research_sequential_trials`, and `research_cost_calibrations`
  all have 0 rows.
- Jangar Postgres is reachable with 25 Kysely migrations applied, latest `20260418_embedding_dimension_4096`, and
  current `agent_runs` updates. Database migration health is not the blocker.
- ClickHouse direct auth was unavailable from this runtime, but the guardrails exporter scraped successfully. It reports
  current TA signal and microbar max event/window timestamps and no low-memory freshness mode, so ClickHouse freshness
  should be consumed through bounded exporter or projection surfaces rather than ad hoc raw queries during admission.

## Problem

Torghut currently has a dangerous distinction between route readiness and order authority. The status route can say
live submission is ready because the simple lane toggles are clear, while the proof-aware submission council, the
hypothesis ledger, Jangar dependency quorum, empirical jobs, signal continuity, and execution freshness all say capital
should be held or rolled back.

This is not only a safety problem. It is a profitability problem. The fastest way to destroy expected edge is to let
capital flow through the path with the least evidence. The current live shape would allow a live-ready surface while no
hypothesis is promotion eligible and realized execution cost evidence is stale. That makes post-cost edge impossible to
trust.

The missing primitive is an order-local authorization object that cannot be bypassed by a route, scheduler lane, or
operator-facing status shortcut.

## Options Considered

### Option A: Patch the Simple-Lane Route Wrapper

Make `main.py::_build_live_submission_gate_payload` call the shared proof-aware submission council even in simple mode.

Pros:

- Fastest fix for the visible false-positive status payload.
- Reuses existing code and tests.
- Gives operators a less misleading `/trading/status` view.

Cons:

- Still leaves broker submission dependent on whether every caller uses the same helper.
- Does not create an auditable per-order proof.
- Does not allocate scarce capital among competing repaired hypotheses.
- Provides limited protection from future route or scheduler drift.

Decision: required as an early engineering step, but not enough as the architecture.

### Option B: Freeze All Live Capital on Any Degraded Dependency

Hold all live orders whenever Jangar, empirical jobs, signal continuity, sim, or route probes are degraded.

Pros:

- Clear failure posture.
- Easy to validate in a smoke test.
- Strongly reduces accidental live submissions during incidents.

Cons:

- Over-blocks observe, repair, shadow, and replay work that is needed to recover.
- Treats stale research proof, market-closed staleness, image-pull warnings, and broker event loss as the same class of
  failure.
- Encourages manual bypasses because the control is too coarse for a trading desk.

Decision: keep as an incident kill posture, not as the steady-state design.

### Option C: Broker-Bound Order Admission Warrants and Replay Capital Auction

Mint a short-lived warrant for each non-shadow order from one settled proof cut, and allocate allowed capital with a
replay-backed auction that ranks hypotheses by fresh post-cost edge and guardrail budget. The broker adapter enforces
the warrant; routes and schedulers can only request one.

Pros:

- Creates one hard authority at the last controllable boundary before external capital.
- Converts proof quality into capital allocation, not just a red or green status.
- Lets Torghut keep serving, observing, shadowing, replaying, and repairing during degraded windows.
- Gives Jangar one compact mirror contract for external-capital admission.
- Produces auditable order-level evidence for every live fill, cancel, reject, or hold.

Cons:

- Adds a new hot-path proof object and requires careful latency budgets.
- Requires order-feed event persistence so warrants can be reconciled against broker outcomes.
- Requires shadow comparison before enforcement to avoid blocking deliberate manual emergency flows.

Decision: select Option C.

## Chosen Architecture

### OrderAdmissionWarrant

Add a short-lived warrant required by every non-shadow broker order.

Required fields:

- `warrant_id`
- `account`
- `window`
- `symbol`
- `side`
- `max_quantity`
- `max_notional`
- `requested_capital_stage`
- `allowed_capital_stage`
- `hypothesis_id`
- `strategy_id`
- `auction_round_id`
- `issued_at`
- `expires_at`
- `issuer`: `torghut`, `jangar_mirror`, or `manual_emergency`
- `decision`: `allow`, `shadow_only`, `repair_only`, `hold`, or `deny`
- `reason_codes`
- `capital_proof_clock_id`
- `jangar_rollout_settlement_digest`
- `market_state_capital_oracle_digest`
- `empirical_job_digest`
- `signal_continuity_digest`
- `tca_budget_digest`
- `replay_bundle_id`
- `shadow_session_id`
- `manual_override_ref`
- `proof_refs`

The warrant is not an advisory status payload. It is the admission token the broker adapter checks before order
submission. Missing, expired, mismatched, or downgraded warrants reject the order before it can leave Torghut.

### ReplayCapitalAuction

Add an auction round per account/window that ranks candidates by proof-backed expected post-cost edge. The auction is
allowed to assign non-shadow capital only when all of these inputs are fresh:

- Jangar rollout settlement includes `external_capital`.
- Capital proof clock decision is `allow`.
- Market-state capital oracle is fresh for the symbol family and market session.
- Empirical job bundle is fresh for the hypothesis family.
- Replay bundle covers the current session template or the configured recent holdout.
- Shadow session evidence has no unresolved reject, slippage, or fill-model break.
- TCA budget is within the hypothesis entry contract.
- Hypothesis runtime state is promotion eligible and `rollback_required` is false.

Auction output is bounded. It returns a maximum notional and maximum quantity, not a generic permission. The broker
adapter must reject any order that exceeds the warrant budget or changes account, symbol, side, hypothesis, or stage.

### Broker Order Firewall

The broker adapter becomes the route-independent enforcement point:

- non-shadow submit requires a valid warrant;
- shadow and paper submit record an optional warrant but may proceed without one;
- cancel and replace operations require either the original warrant or a risk-reducing close warrant;
- emergency orders require a manual warrant with reason, expiry, account, symbol scope, max notional, and approver ref;
- every broker result writes a reconciliation row linking warrant, order id, broker status, fill state, slippage, and
  rejection reason.

### Profitability Hypotheses

This architecture should be measured with explicit hypotheses:

- `WARRANT-FP-01`: route-independent warrants reduce false-positive non-shadow submissions to zero. Success is no live
  broker order without a valid warrant after enforcement.
- `REPLAY-AUCTION-01`: replay capital auction improves post-cost edge by allocating capital only to hypotheses with
  fresh replay or shadow proof. Success is positive post-cost expected value in shadow for three consecutive market
  sessions before canary.
- `TCA-BUDGET-01`: warrant-level TCA budgets reduce realized absolute slippage below the hypothesis maximum before any
  scale-up. Success is no promotion while realized or expected slippage breaches the budget.
- `REPAIR-PRIORITY-01`: held warrants create actionable repair rows with the smallest missing proof. Success is a
  measurable decline in stale empirical and signal-continuity holds over the rollout window.

## Engineer Scope

Implement in this order:

1. Patch simple mode so `main.py::_build_live_submission_gate_payload` consumes the shared proof-aware submission
   council and cannot report live ready when proof clocks block.
2. Add a pure warrant builder under `services/torghut/app/trading/` that consumes `CapitalProofClock`, hypothesis
   runtime status, empirical jobs, Jangar settlement, signal continuity, market context, TCA, replay, and shadow state.
3. Add persistence for warrant issuance and reconciliation. The first migration should include warrant, auction round,
   and broker reconciliation tables with account/window/symbol indexes.
4. Add broker-adapter enforcement before external order submission. This is the hard gate; status routes are consumers.
5. Add replay capital auction shadow output and compare it with the current simple lane before enforcement.
6. Mirror compact warrant decisions into the Jangar quant health surface so Jangar can hold external capital without
   scraping raw Torghut internals.

## Validation Gates

- Unit tests prove the current May 5 evidence shape returns `decision: hold` or `shadow_only`, never non-shadow
  `allow`.
- Route tests prove `/trading/status`, `/readyz`, scheduler status, and the Jangar quant mirror agree on external
  capital when Jangar dependency quorum blocks.
- Broker tests prove non-shadow submit fails closed when the warrant is missing, expired, symbol-mismatched,
  account-mismatched, over-budget, or downgraded by a fresher proof cut.
- Regression tests prove simple mode cannot bypass the shared submission council.
- Replay tests prove auction output is shadow-only until empirical job freshness, signal continuity, TCA budget, replay
  bundle, and hypothesis promotion eligibility are all valid.
- Reconciliation tests prove every live order result links back to a warrant and writes broker status, fill state, and
  slippage evidence.
- Property tests prove monotonic capital behavior: adding a blocking reason can only reduce or expire the allowed stage
  until a newer closing proof exists.

## Rollout and Rollback

Roll out in four phases:

1. Shadow emit warrants and replay auction rounds while keeping current broker behavior unchanged.
2. Enforce route parity by making status, scheduler, and Jangar quant mirror read the same warrant decision.
3. Enforce broker rejection for autonomous and scheduled non-shadow orders.
4. Enforce broker rejection for simple-lane manual non-shadow orders after manual emergency warrants are available.

Rollback is configuration-only:

- disable broker warrant enforcement but keep issuing and reconciling warrants in shadow;
- cap manual notional while enforcement is disabled;
- keep Jangar external-capital action class held unless a manual emergency warrant names the expiry and blast radius;
- never delete warrant or auction history during rollback.

## Risks and Tradeoffs

- Hot-path latency: warrant lookup and validation must be local and bounded. Remote Jangar calls cannot sit on the
  broker submit path.
- Proof staleness: warrants must be short-lived. A long-lived warrant recreates the stale status problem.
- Manual operations: emergency warrants must exist, but they must be explicit, scoped, and expiring.
- Data gaps: `execution_order_events` is empty today, so reconciliation needs to land before the warrant can be the
  only audit source.
- Capital starvation: strict warrants may hold all live capital until proof surfaces are repaired. That is correct for
  external capital, but observe, shadow, replay, and repair paths must stay usable.

## Handoff

Engineer acceptance gate: with the current runtime evidence, no non-shadow order can pass broker admission. The expected
decision is `hold` or `shadow_only` because Jangar dependency quorum blocks, empirical jobs are stale, hypotheses are
not promotion eligible, rollback is required, signal continuity is faulted, and execution/order-feed evidence is stale.

Deployer acceptance gate: before enabling non-shadow capital, verify the broker adapter rejects missing-warrant orders,
Torghut and Jangar report the same external-capital decision, at least one warrant-producing auction round has fresh
replay or shadow proof, `rollback_required_total` is 0 for the account/window, and order reconciliation is writing for
all broker outcomes.
