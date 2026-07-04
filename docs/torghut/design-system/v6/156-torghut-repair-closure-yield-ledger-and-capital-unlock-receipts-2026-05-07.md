# 156. Torghut Repair Closure Yield Ledger And Capital Unlock Receipts (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut repair closure, capital unlock receipts, proof-floor blocker retirement, post-cost edge measurement,
Jangar verdict authority consumption, validation, rollout, rollback, and implementation handoff.

Companion Jangar contract:

- `docs/agents/designs/152-jangar-material-verdict-authority-and-contradiction-debt-ledger-2026-05-07.md`

Extends:

- `154-torghut-marginal-proof-spend-portfolio-and-capital-repair-budget-2026-05-07.md`
- `153-torghut-useful-evidence-capital-escrow-and-provider-repair-gates-2026-05-07.md`
- `152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`

## Decision

I am selecting a repair closure yield ledger with capital unlock receipts as the next Torghut profitability architecture
step.

The current live Torghut service is operationally reachable but economically blocked. Live `/readyz` returned degraded
because the proof floor is `repair_only`, capital is `zero_notional`, the live submit gate is closed, alpha readiness
has no promotable hypothesis, execution TCA slippage is above guardrail, and market context is stale. Simulation is
HTTP `200`, but it is also repair-only and zero-notional. Infrastructure health is not the problem. The missing product
is proof that a repair changed capital eligibility.

The proof-spend portfolio ranks repairs before we run them. That is necessary but incomplete. A high-ranked repair can
still consume Jangar controller budget, provider cost, ClickHouse cost, and engineering time without closing a blocker
or improving post-cost edge. Torghut now needs a closure ledger that measures realized repair yield and emits a
`CapitalUnlockReceipt` only when a repair retires an actual proof-floor blocker or improves a measurable capital gate.

The tradeoff is stricter reentry. Some repairs that make logs look cleaner will not restore paper or live capital. That
is correct. Capital should re-enter when proof changes, not when activity increases.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `repair_closure_yield_ledger` from `/trading/health`, `/readyz`, and `/trading/status`.
- Each admitted repair bid creates a closure record with before/after proof-floor state, cost, measured delta, and
  capital effect.
- A `CapitalUnlockReceipt` is emitted only when closure criteria pass.
- Jangar material verdict authority consumes capital unlock receipt IDs before allowing `paper_canary`,
  `live_micro_canary`, or `live_scale`.
- Repair-only and observe-only work remain available with zero notional when capital unlock is missing.
- Repairs that do not move proof-floor state, post-cost edge, drawdown budget, market-context freshness, TCA slippage,
  or alpha readiness lose future priority.
- Paper widening requires a positive post-cost edge receipt and a bounded drawdown receipt, not just healthy
  dependencies.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Runtime And Cluster Evidence

- Torghut live `/readyz` returned HTTP `503` with `status=degraded`.
- Torghut simulation `/readyz` returned HTTP `200` in paper mode.
- Live and simulation active deployments were both available at `1/1` on digest
  `sha256:8db8a40ee7f76c08aaa0689b55e145dfaf872248707a20fb38c005e0eabb42ab`.
- Torghut options catalog, options enricher, TA jobs, ClickHouse, Keeper, Postgres, LLM guardrails exporter,
  WebSocket services, and Symphony Torghut pods were running.
- Torghut market-context wrappers completed while child provider jobs failed in the Agents namespace.
- A pre-existing `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod was in `Error`.
- Recent events included transient WebSocket readiness failures, duplicate ClickHouse PodDisruptionBudget warnings,
  and Flink status-modified-externally warnings.

### Data And Profit Evidence

- Live dependencies were healthy for Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, and empirical
  jobs.
- Live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage was ready with branch count `1`, no duplicate revisions, no orphan parents, and known parent-fork
  warnings at `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Live submission gate was closed: `allowed=false`, `reason=simple_submit_disabled`, `capital_stage=shadow`.
- Live profitability proof floor was `repair_only`, route state was `repair_only`, and capital state was
  `zero_notional`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live empirical jobs were healthy for candidate `chip-paper-microbar-composite@execution-proof` and dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Live TCA showed `13,775` orders, `13,571` filled executions, latest computed
  `2026-05-07T14:23:44.018621+00:00`, average absolute slippage `13.7594875295276693` bps, and guardrail `8` bps.
- Live quant ingestion was informational but degraded: `latest_metrics_updated_at=2026-05-07T15:09:35.041Z` and
  `max_stage_lag_seconds=77083`.
- Simulation remained repair-only with alpha readiness, execution TCA, and market context blockers. Simulation TCA
  had average absolute slippage `17.4301320928571429` bps against the same `8` bps guardrail.
- Direct CNPG SQL through the service account was RBAC-blocked in Jangar; typed runtime endpoints are the reliable data
  witness for this architecture lane.

### Source Evidence

- `services/torghut/app/main.py` is 4186 lines and already assembles `/readyz`, `/trading/health`, and
  `/trading/status`; it should not absorb repair-yield economics.
- `services/torghut/app/trading/proof_floor.py` is 653 lines and already emits proof dimensions, blocker reasons,
  route state, capital state, and a repair ladder.
- `services/torghut/app/trading/revenue_repair.py` already summarizes proof-floor repair state, but it does not yet
  issue capital-unlock receipts accepted by Jangar.
- `services/torghut/app/trading/submission_council.py` is 1199 lines and must remain the final deterministic order
  gate.
- `services/torghut/app/trading/tca.py` is 969 lines and owns execution TCA refresh and metrics.
- `services/torghut/app/trading/hypotheses.py` is 764 lines and owns hypothesis readiness and promotion semantics.
- Existing tests cover proof floor, TCA, empirical jobs, submission council, trading API readiness, market context,
  and trading scheduler safety. The missing test surface is repair closure yield, capital-unlock receipt issuance, and
  Jangar verdict-authority consumption.

## Problem

Torghut can identify blockers and rank repairs, but it does not yet prove that a repair produced a capital-relevant
outcome. That matters because the system is deliberately zero-notional. The way out of zero-notional is not more repair
activity. It is measured closure.

The current failure modes are:

1. A TCA recompute can produce a fresh TCA row while proving slippage is still worse than the guardrail.
2. A market-context refresh can complete a wrapper while child provider jobs fail or durable evidence stays empty.
3. Alpha readiness can remain shadow-only after unrelated infrastructure repair.
4. Quant ingestion can be informationally degraded while not yet priced into paper or live eligibility.
5. Live submit can stay disabled even after other proof-floor blockers improve.
6. Jangar can safely hold capital, but Torghut needs a typed receipt to show when capital reentry is earned.

## Alternatives Considered

### Option A: Promote Capital When The Proof Floor Is No Longer Repair-Only

Pros:

- Simple rule.
- Uses an existing receipt.
- Easy to explain to deployers.

Cons:

- Does not attribute which repair changed the state.
- Does not price repair cost or opportunity cost.
- Cannot distinguish a meaningful blocker retirement from a coincidental status change.

Decision: reject. It is necessary but not sufficient.

### Option B: Let The Proof-Spend Portfolio Decide Both Repair Admission And Capital Unlock

Pros:

- Reuses the portfolio from the prior contract.
- Avoids adding another ledger.
- Keeps ranking and outcome in one surface.

Cons:

- A bid is a forecast, not proof.
- Combining expected value and realized closure makes bad repairs hard to penalize.
- Jangar needs a compact receipt, not the full portfolio state.

Decision: reject. Forecasts and settlements must stay separate.

### Option C: Add Repair Closure Yield And Capital Unlock Receipts

Pros:

- Measures realized blocker retirement and post-cost edge change.
- Lets bad repairs lose future priority.
- Gives Jangar a stable receipt to consume for paper/live verdicts.
- Keeps zero-notional repair available without weakening capital gates.

Cons:

- Requires a new reducer and persistence surface.
- Needs careful before/after snapshots to avoid false credit.
- Delays capital reentry until closure is measured.

Decision: select Option C.

## Architecture

Add a `repair_closure_yield_ledger` reducer outside `main.py`. It consumes admitted proof-spend bids, proof-floor
snapshots, TCA metrics, market-context freshness, alpha-readiness state, quant-ingestion state, live-submission state,
and Jangar material verdict authority.

`RepairClosureRecord` fields:

- `closure_id`
- `bid_id`
- `repair_dimension`
- `hypothesis_ids`
- `account`
- `source_revision`
- `started_at`
- `closed_at`
- `proof_floor_before`
- `proof_floor_after`
- `blockers_before`
- `blockers_after`
- `blocker_delta`
- `post_cost_edge_bps_before`
- `post_cost_edge_bps_after`
- `drawdown_budget_bps_before`
- `drawdown_budget_bps_after`
- `runtime_cost`
- `controller_cost`
- `data_cost`
- `closure_metric`
- `closure_state`: `closed_positive`, `closed_negative`, `no_effect`, `timed_out`, `contradicted`, or `waived`
- `capital_effect`: `none`, `observe_only`, `paper_unlock_candidate`, `live_micro_unlock_candidate`, or
  `live_scale_unlock_candidate`
- `rollback_target`

`CapitalUnlockReceipt` fields:

- `receipt_id`
- `closure_id`
- `account`
- `hypothesis_id`
- `action_class`: `paper_canary`, `live_micro_canary`, or `live_scale`
- `evidence_window`
- `proof_floor_state`
- `capital_state`
- `post_cost_edge_bps`
- `drawdown_budget_bps`
- `tca_slippage_bps`
- `market_context_freshness_seconds`
- `alpha_readiness_state`
- `quant_ingestion_state`
- `live_submit_state`
- `jangar_authority_ref`
- `capital_decision`: `paper_allowed`, `live_hold`, `live_allowed`, or `blocked`
- `fresh_until`
- `blocking_reason_codes`
- `rollback_target`

Closure scoring:

```text
realized_yield =
  blocker_delta_weight
  + post_cost_edge_delta_weight
  + drawdown_budget_delta_weight
  + freshness_delta_weight
  - runtime_cost_penalty
  - controller_cost_penalty
  - data_cost_penalty
  - regression_penalty
```

Receipt policy:

- `paper_canary` receipt requires proof floor not `repair_only`, positive post-cost edge, bounded drawdown, and no
  unresolved market-context or TCA blocker for the hypothesis window.
- `live_micro_canary` receipt additionally requires live submit policy eligibility, Jangar authority allow, no open
  critical quant-ingestion blocker for the account window, and a deployer approval ref.
- `live_scale` receipt requires prior micro-canary closure, stable TCA under guardrail, and repeated positive
  post-cost evidence.
- A repair with `closed_negative`, `no_effect`, `timed_out`, or `contradicted` can produce repair evidence but cannot
  produce a capital unlock receipt.

## Measurable Trading Hypotheses

Hypothesis 1: Repairs that reduce execution TCA slippage below guardrail unlock more capital value than repairs that
only refresh stale timestamps.

- Metric: slippage bps delta and post-cost edge delta after TCA repair.
- Promotion gate: average absolute slippage below 8 bps for the action window and positive post-cost edge.
- Failure condition: TCA becomes fresh but remains above guardrail or worsens realized shortfall.

Hypothesis 2: Market-context repair is only profitable when it changes admitted decision precision or reduces blocked
candidate opportunity cost.

- Metric: accepted-decision precision versus shadow baseline and opportunity-cost delta for blocked hypotheses.
- Promotion gate: durable market-context evidence fresh for the hypothesis window and improved paper selectivity.
- Failure condition: wrappers complete without durable evidence or precision lift.

Hypothesis 3: Alpha-readiness repair should be credited only when it moves a hypothesis out of shadow with bounded
drawdown and current Jangar authority.

- Metric: promotion-eligible hypothesis count, rollback-required count, and post-cost edge.
- Promotion gate: at least one hypothesis becomes paper eligible without increasing rollback-required count.
- Failure condition: readiness labels improve while capital remains zero-notional or rollback risk increases.

## Guardrails

- No unlock receipt when proof floor is still `repair_only`.
- No unlock receipt when Jangar material verdict authority is missing, stale, held, or blocked for the action class.
- No unlock receipt when the repair did not close its declared closure metric.
- No live receipt while `simple_submit_disabled` remains the live-submission reason.
- No live receipt while execution TCA slippage exceeds guardrail for the action window.
- No paper or live receipt while market context remains stale for a hypothesis that requires it.
- No receipt can outlive its evidence window.
- Observe-only and zero-notional repair remain available when capital unlock is missing.

## Implementation Scope

Engineer stage:

- Add `services/torghut/app/trading/repair_closure_yield.py` with pure reducers for closure records, yield scoring,
  and capital unlock receipts.
- Persist repair closure records and capital unlock receipts with indexes on account, hypothesis, action class,
  closure state, capital decision, and `fresh_until`.
- Extend `/readyz`, `/trading/health`, and `/trading/status` with compact ledger summaries.
- Wire capital unlock receipt refs into the Jangar status client payload used by the submission council.
- Add tests for TCA repair fresh-but-still-bad, market-context wrapper success plus child failure, alpha-readiness
  no-effect repair, Jangar authority hold, and positive paper-unlock receipt.
- Keep submission council as the final order gate. The unlock receipt is required evidence, not a bypass.

Deployer stage:

- Enable ledger in shadow mode and publish closure summaries without changing order admission.
- Require closure records for repair jobs before they can receive repeated proof-spend priority.
- Require capital unlock receipts for paper canaries after one trading day of shadow closure data.
- Require live micro-canary receipts only after paper unlocks show positive post-cost edge and Jangar authority allows
  the action class.

## Validation Gates

- Unit test: TCA recompute that remains above 8 bps creates `closed_negative` and no unlock receipt.
- Unit test: market-context wrapper completion with failed child provider job creates `contradicted` closure and no
  unlock receipt.
- Unit test: alpha-readiness repair that leaves `promotion_eligible_total=0` creates `no_effect`.
- Unit test: Jangar authority `hold` blocks paper and live unlock receipts.
- Unit test: proof floor not repair-only, positive post-cost edge, under-guardrail TCA, fresh market context, and Jangar
  allow creates `paper_allowed`.
- Integration test: `/readyz` remains HTTP `200` in simulation when ledger is shadow-only and dependencies are healthy.
- Deployer smoke: live capital remains zero-notional until a fresh unlock receipt and Jangar authority allow are both
  present.

## Rollout And Rollback

Rollout sequence:

1. `shadow`: compute closure records and unlock candidates with no order-admission effect.
2. `repair-priority`: use closure yield to down-rank repairs that did not move proof state.
3. `paper-unlock`: require fresh paper unlock receipts for paper canaries.
4. `live-unlock`: require fresh live micro-canary receipts plus deployer approval and Jangar authority.

Rollback is staged. Disable `live-unlock`, then `paper-unlock`, then `repair-priority`. Keep shadow ledger calculation
running unless it creates database or runtime pressure. If the ledger is unavailable, the safe fallback is
zero-notional capital with observe and repair lanes available under Jangar authority.

## Risks

- Closure attribution can be wrong if multiple repairs run against the same blocker window. The first implementation
  should require source revision, bid ID, and evidence window to match before awarding closure.
- Post-cost edge can be noisy in short windows. Paper unlock receipts need repeated windows before live scale.
- Strict closure requirements can slow learning. The design keeps observe and zero-notional repair open so learning can
  continue without capital exposure.
- The ledger can become another report if Jangar does not consume it. Capital enforcement must require unlock receipt
  refs.

## Handoff Contract

Engineer acceptance:

- Repair closure records are deterministic for the same bid, before/after proof snapshots, and evidence window.
- Failed or no-effect repairs cannot produce capital unlock receipts.
- Positive paper unlock requires proof-floor improvement, positive post-cost edge, fresh required evidence, and Jangar
  authority allow.
- Submission council still blocks orders when the unlock receipt is missing, stale, held, or contradicted.
- Tests cover TCA, market context, alpha readiness, Jangar authority hold, and positive paper unlock paths.

Deployer acceptance:

- Shadow closure data is observed for at least one trading day before paper unlock enforcement.
- Paper and live unlock enforcement are separate releases.
- Rollback to zero-notional capital is tested before live enforcement.
- Release evidence cites closure IDs, unlock receipt IDs, Jangar authority refs, and the exact blocker delta.

Jangar handoff:

- Jangar material verdict authority consumes `CapitalUnlockReceipt` refs for `paper_canary`, `live_micro_canary`, and
  `live_scale`.
- Missing, stale, or contradicted unlock receipts keep capital held while observe and repair lanes remain available.
- The strictest current authority wins if Torghut and Jangar disagree.
