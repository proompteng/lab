# 43. Torghut Profitability Evidence-Led Architecture and Guardrails (2026-03-15)

Status: Proposed (2026-03-15)

## Objective

Shift Torghut from implicit strategy iteration to an explicit profitability architecture with measurable hypotheses, statistical gates, and rollback-safe execution budgets that can run under frozen/autonomous cycles.

## Assessment Summary

Key observations:

- Torghut control-plane is also frozen (`reason=StageStaleness`) while its swarm contract still reports execution status.
- Torghut pods are running, but `torghut-ta` / simulation services show active workload and `torghut-00134-deployment` has transient readiness/liveness warnings (`HTTP 8012` timeout).
- Completion workflow already includes explicit gates and required artifact fields (`DOC29_PAPER_GATE`, `DOC29_LIVE_CANARY_GATE`, `DOC29_LIVE_SCALE_GATE`) in `services/torghut/app/trading/completion.py`, indicating the execution path is ready for stricter gate contracts.
- No direct CNPG data queries were possible from `agents-sa` namespace due `pods/exec` and `cnpg` RBAC constraints, so database quality proof uses service-level completion traces and migration/contract signals.

## Sources Reviewed

- `services/torghut/app/trading/completion.py`
- `services/torghut/app/trading/empirical_jobs.py`
- `services/torghut/app/trading/completion.py` (status matrix loading and `build_completion_trace`)
- `services/torghut/app/trading` test surface
- Existing design context in `docs/torghut/design-system/v6` and `docs/agents/designs/42-jangar-control-plane-failure-mode-reduction-and-safe-rollout-contract-2026-03-15.md`

## Problem

Current autonomy profitability decisions are often promoted through manual inference rather than a strict hypothesis ledger:

1. Strategy changes are not consistently tied to a single experiment hypothesis with measurable effect size and confidence.
2. Execution risk controls are present but not standardized as part of a staged profitability architecture.
3. Completion records exist but are not yet enforced as a first-class architectural control for what can be promoted in production.
4. In the presence of frozen staging phases, partial optimizations can still consume operational budget without sufficient profitability signal.

## Alternatives

### Option A — Keep current completion gate set as-is

- Scope: only documentation and minor threshold updates.
- Pros: minimal change risk.
- Cons: limited proof strength and no experiment-level decision traceability.

### Option B — Introduce hard numeric thresholds only

- Scope: set stricter alpha thresholds for existing gates.
- Pros: fast implementation.
- Cons: brittle and ignores regime dependence (open/closed markets, volatility shock, symbol clusters).

### Option C — Hypothesis-orchestrator architecture (recommended)

- Scope: introduce explicit hypothesis manifests + portfolio guardrails + evidence budget enforcement before execution and merge.
- Pros: maximizes defensibility of profit changes and minimizes silent regressions with measurable rollback triggers.
- Cons: introduces governance and schema migration overhead.

## Decision

Adopt **Option C** as the next Torghut profitability architecture.

## Architecture

### 1) Hypothesis manifest layer

Define a first-class hypothesis model for every candidate profitability change:

- `HypothesisID`
- `market_regime`: `open`, `pre_market`, `volatile`, `cross_asset`
- `hypothesis`: concise hypothesis sentence with causal mechanism
- `expected_effect`: directional metric target (ex: `Sharpe`, `return`, `hit_rate`, `vol_normalized_pnl`)
- `expected_effect_threshold`
- `sample_plan`: `symbol_set`, `lookback_days`, `holdout_days`, `walkforward_chunks`
- `risk_budget`: max daily drawdown increment, max reject-rate increment, max turnover increase
- `confidence_plan`: confidence intervals or Bayesian posterior thresholds
- `guardrails`: `latency_p99`, `slippage_p95`, queue delay, order rejection entropy
- `evidence_artifacts`: completion IDs, db query IDs, status snapshots
- `degrade_paths`: automatic demotion actions if guardrails violate.

### 2) Hypothesis contract as completion input

Before promotion, completion status must include:

- all required gates from `completion` manifest,
- explicit `hypothesis_id` and `evidence_trace_id`,
- two-stage statistical gate: simulation smoke + live canary,
- minimum sample/coverage proof for symbol coverage,
- explicit `portfolio_impact` summary (not just single-symbol).

### 3) Regime-aware decision engine

- Evaluate hypotheses in separate windows:
  - `bull_open`, `flat_open`, `volatile_open`, `off_hours`.
- Use separate risk budgets by regime so low-volatility gains are not incorrectly generalized.
- Require cross-regime deltas to pass a minimum stability check before promotion, not just best regime score.

### 4) Profitability guardrail contract

Promotion is blocked when any threshold breaches:

- `rolling_drawdown_delta_1d > 2x` baseline,
- `reject_ratio_delta > 1.5x` baseline,
- `slippage_p95` delta > configured limit,
- `signal_lag` breaches for two consecutive windows,
- confidence below minimum for intended regime coverage.

Blocking event must emit:

- `hypothesis_id`
- `failing_metrics`
- `required_remediation` + responsible owner.

## Data/DB and Schema Quality Contract

For every profitable hypothesis proposal, the following sources are required:

- completion traces persisted by `build_completion_trace`,
- status snapshots from torghut trading status and Jangar control-plane status,
- empirical job rows for simulation/live canary and completion artifacts,
- strategy outcome rows used to compute realized risk-adjusted uplift.

Because DB read privileges from current assess context are insufficient, the contract requires immutable evidence artifact references in PRs and deployer evidence bundle instead of ad-hoc CLI DB inspection.

## Execution and rollout model

### Engineer stage

1. Create hypothesis manifest with target market regime and guardrails.
2. Run simulation and produce signed completion trace bundle.
3. Demonstrate evidence by artifact IDs in PR body (including completion gate IDs and db query IDs).
4. Merge only if hypothesis passes `live_canary_observed` and all required evidence fields are populated.

### Deployer stage

1. Rollout starts in low-risk canary namespace with one regime at a time.
2. Maintain automatic rollback if any guardrail breach triggers for two consecutive windows.
3. Freeze Torghut lane if two consecutive hypotheses fail guardrails in same trading day.

## Validation Gates

- Stage gates before promotion:
  - statistically significant uplift over baseline on predefined interval,
  - guardrail thresholds within budget,
  - trace completeness: all required db/status artifacts recorded.
- Deployment gates:
  - live canary p95 latency and reject-ratio within expected band,
  - no safety stop resets unbound.
- Post-deploy gates:
  - 24h/72h review window with evidence snapshot and rollback decision.

## Rollback Strategy

- On guardrail breach, auto-demote hypothesis to `stopped` state and retain candidate binary.
- If a candidate has already merged:
  - auto-prepare revert patch from completion trace,
  - run emergency stop path if reject ratio remains elevated after two measurement windows,
  - re-open only with new hypothesis ID and revised risk budget.

## Risks and Tradeoffs

- **Lower throughput due gate strictness**: mitigate with parallel candidate batching and off-peak scheduling.
- **False negatives from strict confidence rules**: include minimum viable evidence exceptions with owner approval.
- **Cross-regime overfitting**: require regime stability and holdout checks before merge.
- **Data availability uncertainty**: mandate evidence references from immutable completion traces when direct DB reads are unavailable.

## Exit Criteria

- Every candidate hypothesis has a documented manifest and completion evidence chain.
- No promotion when `DOC29_LIVE_CANARY_GATE` is blocked or confidence thresholds are unmet.
- Every guardrail breach creates explicit rollback evidence and does not auto-delete candidate artifacts.
