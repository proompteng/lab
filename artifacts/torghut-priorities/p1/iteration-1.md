# Iteration 1 — Contamination-safe autonomous and DSPy gate evidence hardening

## Scope

- Remove synthetic defaults from promotion-gate-critical inputs in autonomy and replace them with runtime-measured or artifact-derived values.
- Make dependency failures fail-closed for promotion decisions.
- Enforce immutable artifact-truth precedence for DSPy promotion gates.
- Add/keep regression coverage for blocked promotion on missing/stale/untrusted evidence.

## Changes

- `services/torghut/app/trading/autonomy/gates.py`
  - Keep gate input types in fail-closed mode for staleness (`staleness_ms_p95: int | None`) and fragility resolution validity.
  - Added mandatory reason codes for missing/invalid fragility, LLm error ratio, TCA order metrics, and evidence-derived fields.
  - Retained stricter TCA checks with explicit missing/invalid failures rather than synthetic fallback values.

- `services/torghut/app/trading/autonomy/lane.py`
  - Removed synthetic/default TCA fallback payload in `_load_tca_gate_inputs`; failures now return `{}` and propagate to gate evaluation.
  - Used runtime-derived feature staleness and LLM metrics for gate evaluation inputs.
  - Carried these stricter signals into governance and paper-patch output assertions in lane behavior.

- `services/torghut/tests/test_autonomous_lane.py`
  - Updated lane regression expectations to assert promotion is blocked when required evidence is missing/invalid rather than silently passed.
  - Preserved governance override and actuation payload assertions while enforcing closed-loop evidence dependency behavior.

## Verification

- `python3 -m py_compile app/trading/autonomy/gates.py app/trading/autonomy/lane.py app/trading/llm/dspy_compile/workflow.py`
- `python3 -m py_compile` passed for touched modules.
- Attempted to run targeted Torghut Python checks (`python3 -m pytest ...`), `python3 -m ruff`, and `uv ... --frozen --extra dev`, but dependencies/tools are not available in this environment.

## Outcome

- Promotion-critical code paths now default to fail-closed behavior for missing runtime/derived dependencies.
- DSPy and autonomy gate evidence handling is now tied to artifact-backed input resolution in the active path.
- Remaining environment tooling gaps prevented full CI-equivalent validation in this session; those checks are blocked by missing local test/runtime dependencies.
