# Iteration 1

- Objective: enforce contamination-safe, artifact-derived gate evidence and fail-closed behavior.
- Scope touched:
  - `services/torghut/app/trading/autonomy/lane.py`
  - `services/torghut/app/trading/autonomy/gates.py`
  - `services/torghut/app/trading/llm/dspy_compile/workflow.py`
  - `services/torghut/tests/test_autonomous_lane.py`
- Changes:
  1. Removed synthetic fallback behavior for TCA gate inputs by replacing zero-filled fallback with failure signaling:
     - `_load_tca_gate_inputs` now returns empty metrics on collection failure.
     - `_gate2_tca_reasons` now fails when order count is missing/invalid/<= 0 and flags missing metric payloads.
  2. Hardened DSPy orchestration lineage metadata serialization by using `json.dumps(..., default=str)` in `_json_copy`.
     This prevents non-JSON-native types (e.g., datetimes in lineage snapshots) from causing promotion-blocking exceptions.
  3. Updated autonomous lane regression expectations to assert blocked paper promotion and `paper_patch_path is None` when promotion inputs are missing or invalid.
- Validation status:
  - Local Python environment lacks `uv` and project dependencies (`sqlalchemy`), so local test execution could not run.
  - Changes were compiled with `python3 -m py_compile` successfully.
  - CI rerun is required for full green verification.
