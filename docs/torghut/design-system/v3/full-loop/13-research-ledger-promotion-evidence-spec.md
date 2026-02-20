# Research Ledger, Reproducibility, and Promotion Evidence Spec (v3)

## Status
- Version: `v3-ledger-spec`
- Last updated: `2026-02-20`
- Maturity: `draft`

## Objective
Create an immutable promotion evidence contract so every candidate can be replayed and independently verified before paper/ live transition.

## Scope
- Postgres ledger schema.
- Ledger writer in `run_autonomous_lane` and replay pipelines.
- Gate evaluator input/output binding to ledger rows.
- Evidence export format consumed by audit and AgentRun handoff.

## Data Model (minimum required fields)

### `research_runs`
- `run_id` (uuid)
- `created_at`
- `strategy_id`, `strategy_name`, `strategy_type`, `strategy_version`
- `code_commit`
- `feature_version`
- `feature_schema_version`
- `feature_spec_hash`
- `signal_source`
- `dataset_version`, `dataset_from`, `dataset_to`, `dataset_snapshot_ref`
- `runner_version` / `runner_binary_hash`
- `status` (`running|passed|failed|rejected|rolled_back`)

### `research_candidates`
- `run_id`, `candidate_id`
- `candidate_hash`
- `parameter_set` (json)
- `decision_count`, `trade_count`
- `symbols_covered`
- `universe_definition`

### `research_fold_metrics`
- `candidate_id`, `fold_name`, `fold_order`
- `train_start`, `train_end`, `test_start`, `test_end`
- `decision_count`, `trade_count`, `gross_pnl`, `net_pnl`
- `max_drawdown`, `turnover_ratio`, `cost_bps`, `cost_assumptions`
- `regime_label`

### `research_stress_metrics`
- `candidate_id`
- `stress_case` (spread/vol/liquidity/halt)
- `metric_bundle` (json)
- `pessimistic_pnl_delta`

### `research_promotions`
- `candidate_id`, `requested_mode`, `approved_mode`
- `approver`, `approver_role`
- `approve_reason`, `deny_reason`
- `paper_candidate_patch_ref`
- `effective_time`

## Gate Coupling
- Gate evaluator writes a `promotion_decision` row that records:
  - policy checksum
  - gate pass/fail per gate
  - unresolved reasons with reproducible evidence refs
- Gate `gate6_profitability_evidence` is mandatory for `paper` and `live` promotion targets.
  - Requires `profitability-evidence-v4` + `profitability-benchmark-v4` schemas.
  - Requires validator status `passed=true`.
  - Enforces configured thresholds for market uplift, regime coverage, cost realism,
    calibration error, and reproducibility hash count.
- A promotion is valid only when:
  1. `run_id` exists and is immutable,
  2. required folds >= minimum,
  3. null-ratio and staleness gates pass,
  4. profitability evidence validator passes with complete artifacts,
  5. reproducibility check passes,
  6. selection-bias checks are within guardrail thresholds.

## Reproducibility Contract
- Inputs for every run are addressable and versioned.
- Re-run must produce metric deltas inside configured tolerance.
- Regressions are recorded as deterministic deny events.

## Artifacts
- `research-report.json` (machine-readable)
- `research-report.md` (human readable)
- `gate-evaluation.json` reference hash
- `profitability-benchmark-v4.json` (baseline vs candidate by market/regime slices)
- `profitability-evidence-v4.json` (risk-adjusted + realism + calibration + reproducibility contract)
- `profitability-evidence-validation.json` (machine-readable pass/fail + reason codes)
- `promotion-evidence-gate.json` (final promotion gate aggregation + artifact pointers)
- `paper-candidate/strategy-configmap-patch.yaml` when promotion_allowed

## Acceptance Criteria
- Any strategy candidate promoted to paper must have full ledger rows in all four tables.
- Every deny has a reason code + evidence refs.
- `run_autonomous_lane` fails fast when ledger write fails in strict mode.
- Evidence export can be replayed by an operator to reproduce the lane outcome.
- Promotion cannot proceed when profitability evidence artifacts are missing, non-reproducible, or below threshold.
