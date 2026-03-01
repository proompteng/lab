# Iteration 4 — Immutable DSPy promote evidence and fail-closed gating

## Scope completed
- Remove permissive promote-lane evidence overrides so promotion-critical inputs are immutable and derived from artifact artifacts only.
- Ensure missing/stale/untrusted promotion evidence blocks promotion and records explicit trust-failure metadata.
- Add regression coverage for immutable promote payload behavior and existing gate-blocking cases.

## Code changes

- `services/torghut/app/trading/llm/dspy_compile/workflow.py`
  - Hardened `_PROMOTION_EVIDENCE_OVERRIDE_KEYS` to include `artifactHash` so promote submissions cannot inject synthetic evidence.
  - Kept promote `evalReportRef` fixed to `${artifact_root}/eval/dspy-eval-report.json` via `_lane_overrides_with_defaults`.
  - Promotion checks already load and validate evidence from artifact-root-local `eval/dspy-eval-report.json` via `_resolve_promotion_gate_snapshot` and block when untrusted/missing/stale/invalid.

- `services/torghut/app/trading/autonomy/lane.py`
  - Uses artifact/policy-derived gate inputs for feature schema and readiness booleans.
  - Replaced inline candidate state construction with `_build_candidate_state_payload(...)` and wired `datasetSnapshotRef` from runtime `signals_path`.

- `services/torghut/tests/test_llm_dspy_workflow.py`
  - `test_orchestrate_dspy_agentrun_workflow_ignores_promotion_gate_overrides` confirms `artifactHash` is stripped from promote parameters and `evalReportRef` is canonicalized to artifact-root.
  - Existing blocking tests cover missing, stale, outside-artifact, and invalid eval-report snapshots for promotion lane.

## Verification
- `source .venv-torghut/bin/activate && PYTHONPATH=services/torghut .venv-torghut/bin/pytest services/torghut/tests/test_llm_dspy_workflow.py services/torghut/tests/test_autonomous_lane.py -q`
