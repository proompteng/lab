# 02. Gate Policy Matrix

## Objective
Define mandatory automated promotion gates with explicit pass/fail criteria and stop conditions for autonomous Torghut
operations.

## In Scope
- gate semantics and thresholds,
- gate output contract,
- automatic actions on failure,
- integration with CI and runtime control paths.

## Gate Matrix

### Gate 0: Data Integrity
Pass criteria:
- schema version compatible with strategy requirements,
- required feature null-rate under threshold,
- staleness within budget.

Fail criteria:
- schema mismatch,
- stale or duplicate spike,
- missing required symbol coverage.

### Gate 1: Statistical Robustness
Pass criteria:
- walk-forward stability across folds,
- stress scenarios within tolerated degradation,
- overfit diagnostics within allowed limits.

Fail criteria:
- fold fragility,
- reliance on narrow in-sample windows,
- failed multiple-testing adjustments.

### Gate 2: Risk and Capacity
Pass criteria:
- portfolio concentration within limits,
- participation/slippage estimates within policy,
- no hard risk limit breach in simulation.

Fail criteria:
- concentration breach,
- capacity violation,
- unstable allocator behavior.

### Gate 3: Shadow/Paper Execution Quality
Pass criteria:
- TCA metrics within target bands,
- policy engine stability,
- no unexplained order churn spikes.

Fail criteria:
- sustained slippage degradation,
- repeated execution-policy failures,
- anomalous cancel/replace ratios.

### Gate 4: Operational Readiness
Pass criteria:
- oncall runbooks validated,
- kill switch and rollback dry-runs passed,
- observability dashboards and alerts active.

Fail criteria:
- incomplete recovery runbook,
- failed rollback simulation,
- missing alert coverage for critical paths.

### Gate 5: Live Ramp Readiness
Pass criteria:
- required paper duration and stability achieved,
- compliance evidence package complete,
- explicit approval token present.

Fail criteria:
- missing approvals,
- unresolved high severity findings,
- drift between reviewed config and deploy target.

## Decision Output Contract
Each gate emits JSON:
- `gate_id`
- `status` (`pass` or `fail`)
- `reasons`
- `artifact_refs`
- `evaluated_at`
- `code_version`

## Automatic Actions
- any failed gate blocks advancement,
- gate failures open research feedback issue with reason class,
- gate 4/5 failures trigger operator escalation,
- repeated failures can auto-freeze candidate ID.

## Agent Implementation Scope (Significant)
Workstream A: policy engine
- implement rule evaluation library for all 6 gates.

Workstream B: policy config and versioning
- define typed gate policy schema and version migration path.

Workstream C: report and notification
- generate machine-readable reports and markdown summaries.

Workstream D: CI/runtime integration
- enforce gate checks in research scripts and promotion pipelines.

Owned areas:
- `services/torghut/app/trading/reporting.py`
- `services/torghut/scripts/**`
- `services/torghut/tests/**`
- `argocd/applications/torghut/**` (promotion guard flags)

Minimum deliverables:
- gate evaluator module,
- policy config file,
- report writer,
- CI checks and failure alert hooks.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-gate-matrix-impl-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `gateConfigPath`
  - `artifactPath`
- Expected artifacts:
  - gate evaluator scripts,
  - policy config file,
  - machine-readable gate reports.
- Exit criteria:
  - each gate testable in CI,
  - end-to-end pass/fail demo recorded,
  - report schema stable and versioned.
