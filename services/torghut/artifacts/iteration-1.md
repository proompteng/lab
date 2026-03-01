# Iteration 1 — DSPy + autonomy gate evidence hardening

## Scope completed
- Enforced DSPy promotion gate decisions to use artifact-truth (`<artifact_root>/eval/dspy-eval-report.json`) for evaluate/promotion evidence.
- Eliminated permissive override paths that previously allowed synthetic values to bypass required evidence.
- Added failure-closed behavior for missing/stale/untrusted artifacts.

## Code changes
- `services/torghut/app/trading/autonomy/gates.py`
  - `GateInputs.staleness_ms_p95` now accepts `int | None`.
  - `_resolve_gate_staleness_ms_p95` returns `None` when signal ingest timestamps are missing, producing `feature_staleness_missing` in gate decisions.
- `services/torghut/app/trading/autonomy/lane.py`
  - Enforced hard dependency on actual runtime staleness signal instead of defaulting to synthetic `now`.
  - `run_autonomous_lane` staleness computation now returns missing/invalid timestamps as an explicit fail input.
- `services/torghut/app/trading/llm/dspy_compile/workflow.py`
  - `orchestrate_dspy_agentrun_workflow` now passes `artifact_root` into promotion snapshot resolution and gates with live `datetime`.
  - `_promotion_gate_failures` now returns fail reasons for:
    - reference override / out-of-root / non-local references,
    - missing artifact,
    - invalid JSON,
    - stale artifacts,
    - missing or invalid metric fields.
  - `orchestrate...` persists blocked promote rows with captured `gateSnapshot` / `gateFailures` in metadata.

## Regression tests added/updated
- `services/torghut/tests/test_llm_dspy_workflow.py`
  - `test_orchestrate_dspy_agentrun_workflow_submits_lanes_and_persists_rows`
    - now seeds a real artifact evaluation snapshot and uses artifact-root-relative inputs.
  - `test_orchestrate_dspy_agentrun_workflow_blocks_promotion_on_gate_failure`
    - continues to validate gate failures using artifact-derived evidence.
  - Added:
    - `test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_missing`
    - `test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_stale`
    - `test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_path_is_untrusted`
  - Added local helpers:
    - `_build_dspy_lane_overrides`
    - `_write_dspy_promotion_eval_snapshot`
- `services/torghut/tests/test_autonomy_gates.py`
  - Added `test_gate_matrix_blocks_when_llm_metrics_missing` for fail-closed LLM metric dependency in gate matrix.
- `services/torghut/tests/test_autonomous_lane.py`
  - Signal fixtures now include ingestion timestamps where staleness is evaluated.
  - Test signal payloads with inline JSON fixtures now include `ingest_ts`.
- `services/torghut/tests/fixtures/walkforward_signals.json`
  - Added `ingest_ts` for each fixture signal.
