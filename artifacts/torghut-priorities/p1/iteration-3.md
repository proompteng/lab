# Iteration 3 — Derive critical gate inputs from runtime/state and enforce artifact-driven gate truth

## Scope

- Remove remaining hardcoded/synthetic gate inputs in autonomy promotion critical path.
- Derive gate readiness inputs from runtime state payload and configuration artifacts rather than unconditional `True`.
- Add regression coverage for blocked promotion when runbook evidence artifact is missing.
- Record execution outcomes against missing/stale/invalid evidence gates in DSPy promotion workflow via existing regression coverage.

## Changes

- `services/torghut/app/trading/autonomy/lane.py`
  - Moved `candidate_state_payload` construction to the gate-evaluation section so gate inputs can be sourced from candidate rollout state.
  - Replaced hardcoded `feature_schema_version="3.0.0"` with artifact policy value `gate_policy.required_feature_schema_version` to avoid config drift.
  - Replaced hardcoded values for `operational_ready`, `runbook_validated`, `kill_switch_dry_run_passed`, and `rollback_dry_run_passed` in `GateInputs` with fail-closed, evidence-derived booleans:
    - `operational_ready` from candidate paused state.
    - `runbook_validated` from `strategy_configmap_path` existence.
    - kill-switch/rollback readiness from `candidate_state_payload["rollbackReadiness"]`.

- `services/torghut/tests/test_autonomous_lane.py`
  - Added `test_lane_blocks_promotion_when_runbook_evidence_is_missing` to verify a missing runbook artifact blocks promotion with `runbook_not_validated`.

## Verification

- Attempted:
  - `pytest services/torghut/tests/test_autonomous_lane.py::TestAutonomousLane::test_lane_blocks_promotion_when_runbook_evidence_is_missing`
  - `pytest services/torghut/tests/test_autonomous_lane.py::TestAutonomousLane::test_lane_emits_gate_report_and_paper_patch`
  - `pytest services/torghut/tests/test_llm_dspy_workflow.py::TestLLMDSPyWorkflow::test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_missing`
  - `pytest services/torghut/tests/test_llm_dspy_workflow.py::TestLLMDSPyWorkflow::test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_stale`
  - `pytest services/torghut/tests/test_llm_dspy_workflow.py::TestLLMDSPyWorkflow::test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_payload_is_invalid`
- Failed to execute in this environment because test tooling is unavailable (`pytest`/`uv` not installed).

## Notes

- DSPy immutable artifact-truth precedence for promotion evidence (`evalReportRef` and hard-coded override stripping) remains in place and is already covered by existing promotion-blocking regression tests in `test_llm_dspy_workflow.py`.
