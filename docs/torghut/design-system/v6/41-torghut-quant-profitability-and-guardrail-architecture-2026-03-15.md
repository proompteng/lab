# 41. Torghut Quant Profitability Architecture and Risk Guardrail Contract (2026-03-15)

## Status

- Date: `2026-03-15`
- Maturity: `architecture decision + implementation contract`
- Scope:
  - `services/torghut/app/{hypotheses.py,trading/lane.py,trading/autonomy/lane.py,completion.py,trading/trading_pipeline.py,empirical_jobs.py}`
  - `services/torghut/tests/{test_hypotheses.py,test_empirical_jobs.py,test_trading_api.py,test_profitability_evidence_v4.py}`
  - `docs/runbooks/torghut-quant-control-plane.md`
- Objective: increase profitability trajectory while preserving hard fail-closed constraints by introducing measurable, capital-stage aware promotion architecture.

## Assessment snapshot (2026-03-15)

### Source assessment

- `hypotheses.py` currently compiles readiness from live counters and dependency reasons, with strong structure but limited evidence granularity.
- `empirical_jobs.py` and `completion.py` already enforce authoritative empirical families when present, but families are currently absent in runtime.
- Autonomy/advisor surfaces already track signals, gates, and post-cost placeholders, but they are not yet systematically converted into a profitability capital market.
- Tests exist for hypothesis status behavior and empirical-job continuity, but there is no durable test for cross-hypothesis profitability partitioning under mixed proof windows.

### Cluster assessment

- Torghut pod topology is healthy, with live and sim services running.
- `kubectl` event stream shows no hard Pod termination storm but still includes control-plane probe/resting artifacts.
- Jangar endpoint health is mostly healthy while empirical jobs remain degraded.

### Database/data assessment

- `/readyz` and `/db-check` currently report schema current, signature-stable runtime state, and no schema delta.
- `/trading/status` reports:
  - `hypotheses_total=3`,
  - `capital_stage_totals.shadow=3`,
  - `promotion_eligible_total=0`,
  - blocker reasons dominated by missing feature rows, missing empirical continuity, and `signal_lag_exceeded`.
- `/trading/empirical-jobs` shows all required families missing and stale (`stale=true` / `truthful=false`).
- No empirical job families means capital progression is effectively disconnected from profit evidence.

## Problem statement

The system has a strong safety shell, but profitability is not engine-driven:

1. one-size-fits-all readiness counters hide per-hypothesis differences,
2. no persistent profitability window contract exists for capital-stage transitions,
3. empirical evidence is binary and global instead of ranked by strategy and horizon,
4. signal continuity and feature coverage are used as blockers, but those counters are process state, not profit-time evidence.

The immediate result is a safe but static state: no hypothesis can progress, despite healthy dependencies.

## Alternatives considered

### Option A: raise sensitivity of current counters

- reduce thresholds for `feature_batch_rows_total`, `signal_lag_seconds`, and remove temporary blockers.
- Benefit: quick path to visibility.
- Why rejected: increases risk of premature live capital with weak evidence.

### Option B: move to global score only

- keep readiness per hypothesis but replace detailed gates with one profitability score.
- Benefit: simple operations dashboard.
- Why rejected: hides why one hypothesis should remain blocked while another advances.

### Option C (chosen): hypothesis profit-market with evidence lanes

- create an explicit `profitability proof market` where each hypothesis has independent evidence windows,
- allocate capital by bounded dynamic budgets derived from post-cost profitability and drawdown behavior,
- use promotion and demotion as policy decisions with clear guardrails and telemetry.

## Decision

Adopt `Profitability-as-Flow v1`:

1. introduce hypothesis-scoped profitability contracts with measured windows, risk budgets, and evidence lineage,
2. gate capital stages by a multi-horizon proof ladder,
3. allow independent hypothesis progression where evidence supports one strategy while another remains blocked,
4. bind profitability assumptions to explicit guardrails (`max_adverse_cost_rate`, `max_drawdown`, minimum sample quality).

## Architecture

### 1. Hypothesis Profitability Lanes

Each hypothesis gets a long-lived lane object:

- `proof_horizon_t1`: short horizon execution continuity (replay/live warmup),
- `proof_horizon_t7`: medium horizon slippage and cost drift,
- `proof_horizon_t30`: regime and drawdown stability.

Lane status outputs:

- `lane_state` (`shadow`, `shadow_canary`, `live_canary`, `scaled_live`, `rollback`),
- `lane_budget_bps` (allocated risk budget),
- `lane_guardrails` (per-horizon thresholds),
- `lane_health` (`healthy` / `caution` / `blocked`).

### 2. Capital-stage market with risk budget

Replace single scalar `capital_multiplier` with explicit budget distribution:

- each hypothesis has base budget allocation for `shadow`,
- canary transfer requires:
  - minimum sample count,
- observed post-cost expectancy above threshold,
- and route-quality confidence above configured floor.

Caps and rules:

- live canary requires both post-cost expectancy and route quality stability,
- scale-up requires two consecutive successful canary windows,
- one hypothesis can scale while another remains blocked, if guardrails permit.

### 3. Feature and market-data completeness as hypothesis contracts

Required feature bundles become contract fields:

- `required_feature_set_coverage` (per strategy),
- `feature_gap_penalty` (non-blocking only if explicitly safe),
- `market_context_coverage` by domain (`technicals`, `fundamentals`, `news`).

This changes why a hypothesis blocks:

- from generic global reason sets,
- to precise deficiency IDs for each required component.

### 4. Empirical evidence as recurring profitability input

- empirical run families are not optional; they continuously refresh lane evidence,
- a hypothesis can only be in `live_canary` if all required families are present and authoritative,
- stale empirical artifact invalidates only the affected lane, not every hypothesis.

### 5. Degrader and demoter contract

- positive profitability windows can de-rate from `live_canary` to `shadow` on sustained underperformance.
- demotion triggers are explicit:
  - `drawdown_breached`,
  - `post_cost_expectancy_drop`,
  - `route_quality_degraded`.
- demotion is logged with lane lineage so operators can reconcile exactly where performance drift started.

## Implementation contract

### Wave A. Lane model and schema contracts

Engineer stage:

- define hypothesis profit lane model with persisted proof window records,
- persist evidence refs for `feature_coverage`, `market_context`, `empirical_jobs`, `execution_quality`, and `market_session_quality`,
- expose lane state through `/trading/status` and `/trading/health`.

Acceptance gates:

- each hypothesis has at least one lane state object in API response,
- `/trading/status` reasons are lane-derived and not only global counters,
- evidence refs remain deterministic across restarts.

### Wave B. Capital-stage allocator redesign

Engineer stage:

- replace single-stage binary progression with budget-aware allocator transitions (`shadow` -> `canary` -> `scaled_live`),
- persist cap-adjustment decisions with guardrail violations,
- enforce demotion/rollback by lane rules, not by hand-authored overrides.

Acceptance gates:

- at least one hypothesis can remain `shadow` while another reaches `live canary`,
- two hypotheses can be evaluated with different guardrail postures without one forcing the other.

### Wave C. Guardrail and profitability gate tuning

Engineer + deployer stage:

- publish thresholds for post-cost expectancy, max drawdown, route instability,
- define `H1/H2/H3` proof hypotheses and expected confidence bounds,
- integrate into existing `completion` and `promotion` surfaces as first-class gate families.

Acceptance gates:

- `promotion_eligible_total` is nonzero after at least one recurring profitable window meeting contract,
- `no_signal_windows` and route-quality counters can no longer be the only gating layer for capital stage progression.

## Measurable profitability hypotheses

- H1: with recurring lane proof and budget gating, at least one hypothesis reaches `live_canary` within two sessions after jobs refresh (instead of remaining permanently at shadow).
- H2: mean time-to-safe-capital-progression (`state transition from shadow to live_canary`) drops by at least 40% once lane evidence is in place.
- H3: after one market session at `live_canary`, post-cost route quality variance decreases by at least 20% versus pre-contract counters-only blocking behavior (with no increase in adverse drawdown incidents).

## Validation plan

### Automated tests

- new lane model schema tests for proof windows,
- transition tests for `shadow -> canary -> scaled_live`,
- demotion tests for profitability deltas,
- regression tests proving one-lane independence (one hypothesis canary does not block unrelated lanes).

### Live validation

- `/trading/status` must show per-hypothesis lane state and lane budget.
- `/trading/empirical-jobs` freshness must feed lane health in the same API response.
- `/trading/health` rollout summary and reason list should align with lane contracts.
- `/readyz` must continue blocking trading when guardrails fail, while still exposing lane-level recovery signals.

## Rollout plan

1. ship Wave A (lane model + API surface),
2. validate in one session with recurring empirical jobs absent (should remain shadow-safe),
3. ship empirical-job refresh orchestration and resume recurring prove-and-promote path,
4. ship Wave B allocator and gate tuning for canary only,
5. ship Wave C demoter + full capital allocation with rollback controls.

## Rollback plan

- disable lane-based allocation and restore existing scalar promotion path,
- disable profitability gate deltas and keep minimal safe caps in place,
- require explicit operator confirmation before live canary resumes.

Hard rollback triggers:

- any lane transitions faster than `1 transition / 4h` without new sample quality,
- sustained negative post-cost expectancy over two windows with rising `evidence_continuity_check` false positives,
- repeated cross-hypothesis bleed where one demotion hides another hypothesis's failure.

## Risks

- overfitting to short windows while claiming profitability,
- budget oscillation if canary transitions are too permissive,
- empirical scheduler delay exposing capital starvation in all lanes,
- operational complexity in interpreting lane states during high volatility windows.

## Engineer handoff

Engineer stage is complete only when:

1. hypothesis profitability lane model is persisted and surfaced,
2. capital allocator obeys lane-based budgets and explicit demotion rules,
3. `/trading/status` and `/trading/health` expose lane transitions and reasons per hypothesis,
4. tests validate lane independence and deterministic demotions.

## Deployer handoff

Deployer stage is complete only when:

1. recurring empirical jobs refresh lane inputs for at least one session,
2. one hypothesis canary transition has run under live guardrails,
3. rollback triggers are tested and documented in the runbook,
4. risk thresholds remain at conservative defaults until profitability evidence supports expansion.

## Final recommendation

Profitability should not be inferred from a clean process state.

It should be produced by competing, bounded hypothesis lanes with explicit risk budgets, recurrent proof, and transparent demotion logic.
