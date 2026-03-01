# Iteration 3 — Runtime-derived autonomy readiness and immutable DSPy promote evidence truth

## Scope completed

- Removed remaining hardcoded/synthetic values from autonomy gate readiness inputs and built candidate rollback-readiness payload from runtime/artifact-derived signals.
- Hardened DSPy promote-lane parameter handling to prevent evidence override leakage and enforce artifact-root report truth.
- Added regression coverage around immutable `evalReportRef` behavior in promotion lane payload construction.

## Code changes

- `services/torghut/app/trading/autonomy/lane.py`
  - Replaced hardcoded `feature_schema_version` with policy-derived value from gate policy payload, with settings fallback.
  - Added runtime-derived readiness helpers for gate input booleans:
    - `operational_ready`
    - `runbook_validated`
    - `kill_switch_dry_run_passed`
    - `rollback_dry_run_passed`
  - Extracted candidate rollback payload assembly into `_build_candidate_state_payload`.
  - Wired candidate rollback payload to use the actual `signals_path` as `datasetSnapshotRef`.

- `services/torghut/tests/test_llm_dspy_workflow.py`
  - `test_orchestrate_dspy_agentrun_workflow_ignores_promotion_gate_overrides` now validates:
    - `evalReportRef` remains fixed to `<artifact_root>/eval/dspy-eval-report.json` in submitted promote parameters,
    - evidence override fields are not sent.

## Regression tests

- `services/torghut/tests/test_llm_dspy_workflow.py`
  - `test_orchestrate_dspy_agentrun_workflow_ignores_promotion_gate_overrides`
    - verifies immutable promote evidence inputs and `evalReportRef` canonicalization.
  - Existing DSPy artifact-gating coverage still covers blocking on missing/stale/untrusted eval evidence.
