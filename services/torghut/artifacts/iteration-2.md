# Iteration 2 — Fail-closed, artifact-truth DSPy/autonomy promotion evidence

## Scope completed

- Enforced fragility gate input fallback to conservative values when runtime evidence is missing or malformed.
- Removed janus evidence dependency on profitability gate configuration so required targets are enforced independently and safely.
- Hardened DSPy promotion lane input handling so gate-evidentiary parameters cannot override artifact-derived evidence.
- Added regression coverage for missing/stale/untrusted evidence behavior and override filtering.

## Code changes

- `services/torghut/app/trading/autonomy/lane.py`
  - `_coerce_fragility_state` now fails closed on missing/invalid states by defaulting to `crisis`.
  - `_resolve_gate_fragility_inputs` now fail-closes missing fragility score telemetry with a default score of `1`.
- `services/torghut/app/trading/autonomy/policy_checks.py`
  - `_requires_janus_evidence` now gates only on Janus flags and target list (independent of profitability flag), and respects `promotion_require_janus_evidence`.
- `services/torghut/scripts/run_dspy_workflow.py`
  - Removed synthetic promotion-gate defaults from CLI argument model and lane override payload construction.
- `services/torghut/app/trading/llm/dspy_compile/workflow.py`
  - Added promotion evidence override key stripping in `_lane_overrides_with_defaults` for promote lane parameters.
  - Ensures `artifactHash` and gate-metric fields are not accepted as override signals.

## Regression tests

- `services/torghut/tests/test_autonomous_lane.py`
  - `test_gate_fragility_inputs_fail_closed_on_missing_or_invalid_values` asserts fail-closed fragility defaults (`state=crisis`, `score=1`, `stability=false`).
- `services/torghut/tests/test_policy_checks.py`
  - `test_promotion_prerequisites_requires_janus_even_when_profitability_disabled` now verifies janus artifacts are still required when Janus is enabled but profitability is disabled.
  - `test_promotion_prerequisites_skips_janus_when_not_required` verifies `promotion_require_janus_evidence=False` continues to skip Janus evaluation.
- `services/torghut/tests/test_llm_dspy_workflow.py`
  - `test_orchestrate_dspy_agentrun_workflow_ignores_promotion_gate_overrides` verifies override-like values for artifact hash and gate metrics are not sent as promote lane parameters when evidence is derived from `eval` artifact truth.
  - Existing missing/stale/untrusted eval report tests remain to cover blocked promotion paths.
