# Iteration 2 — Fail-closed fragility evidence in autonomy gates

## Scope

- Remove synthetic fragility fallback values from the autonomy gate-critical path when no valid evidence exists.
- Ensure gate2 fail-closed behavior triggers on invalid fragility evidence before applying fragility thresholds.
- Confirm regression coverage for fail-closed behavior in autonomy gate input resolution.

## Changes

- `services/torghut/app/trading/autonomy/lane.py`
  - Updated `_resolve_gate_fragility_inputs` so missing or unparsable fragility evidence resolves to an explicit invalid state tuple instead of crisis synthetic hard-stop values.
  - Keeps the returned `(fragility_state, fragility_score, stability_mode_active, fragility_inputs_valid)` contract and preserves runtime-derived values when they are present.

- `services/torghut/app/trading/autonomy/gates.py`
  - Updated `_gate2_base_reasons` to fail-closed immediately on `fragility_inputs_valid == False`.
  - Prevents downstream fragility thresholds/state checks from evaluating with synthetic placeholders when evidence is invalid.

- `services/torghut/tests/test_autonomous_lane.py`
  - Updated `test_gate_fragility_inputs_fail_closed_on_missing_or_invalid_values` to assert failure flagging semantics after this change.
  - Kept regression coverage around invalid/missing fragility paths while dropping assertions that encoded synthetic crisis defaults.
- `services/torghut/tests/test_autonomy_gates.py`
  - Added missing TCA keys to `test_gate_matrix_passes_paper_with_safe_metrics` so the "healthy" fixture now exercises complete evidence and remains pass-closed under strict gate checks.
- `services/torghut/tests/test_llm_dspy_workflow.py`
  - Added `test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_override_changes_path` to prove promotion gating is immutable to non-canonical `evalReportRef` overrides.

## Verification

- `pytest services/torghut/tests/test_autonomous_lane.py::TestAutonomousLane::test_gate_fragility_inputs_fail_closed_on_missing_or_invalid_values`
- `pytest services/torghut/tests/test_autonomy_gates.py::TestAutonomyGates::test_gate_matrix_fails_when_fragility_inputs_are_invalid`
- `pytest services/torghut/tests/test_autonomy_gates.py::TestAutonomyGates::test_gate_matrix_passes_paper_with_safe_metrics`
- `pytest services/torghut/tests/test_llm_dspy_workflow.py::TestLLMDSPyWorkflow::test_orchestrate_dspy_agentrun_workflow_blocks_promotion_when_eval_report_override_changes_path`
- `pytest services/torghut/tests/test_llm_dspy_workflow.py`
