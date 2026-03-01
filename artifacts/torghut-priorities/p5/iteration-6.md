# Iteration 6 — Evidence-derived promotion gates and fail-closed behavior

## Scope

- Replace synthetic and synthetic fallback gate inputs with runtime-measured or artifact-derived evidence in both autonomy and DSPy promotion paths.
- Make missing or invalid dependencies fail-closed for promotion decisions.
- Tighten DSPy promotion-gate input precedence to require immutable artifact evidence.
- Add regression coverage for blocked promotion on missing, stale, or untrusted evidence.

## Changes

- `services/torghut/app/trading/autonomy/lane.py`
  - Updated fragility gate input extraction to avoid synthetic crisis fallbacks.
  - Updated fail-closed behavior to return `not_measured` fragility state and zero-violence defaults when dependent inputs are unavailable.
  - Made TCA gate input loading return `None` for aggregate metrics when TCA dependencies fail, while preserving observable order counts.

- `services/torghut/app/trading/tca.py`
  - Updated `build_tca_gate_inputs` to preserve `None` when expected shortfall aggregate values are missing instead of coercing to zero.

- `services/torghut/app/trading/llm/dspy_compile/workflow.py`
  - Expanded promotion evidence override key handling to include `evalReportRef`.
  - Reworked promotion-gate snapshot loading to evaluate requested override refs against artifact-root immutability and canonical reference rules before any promotion submission.
  - Dropped synthetic/override gate inputs from the promote payload so downstream AgentRun execution must use artifact-derived evidence.

- `services/torghut/app/trading/autonomy/policy_checks.py`
  - Enforced invalid Janus evidence artifact schema as hard blockers for promotion prerequisites.

## Regression coverage

- `services/torghut/tests/test_autonomous_lane.py`
  - Updated fragility fallback assertions to verify `not_measured` and fail-closed default behavior.
  - Added broader iteration/gate evidence regressions for stale/missing dependency behavior.

- `services/torghut/tests/test_llm_dspy_workflow.py`
  - Added regression coverage for blocked DSPy promotion when override references are non-canonical.
  - Preserved assertions that synthetic/override gate inputs are stripped prior to AgentRun submission.

- `services/torghut/tests/test_policy_checks.py`
  - Added regression for janus artifact schema invalidation preventing promotion prerequisites from passing.

## Verification

- Attempted to run targeted Python unit tests:
  - `python3 -m unittest services/torghut/tests/test_autonomous_lane.py services/torghut/tests/test_llm_dspy_workflow.py services/torghut/tests/test_policy_checks.py`
  - Failed due missing runtime dependencies (`sqlalchemy`) and missing tooling (`uv`) in this environment.
- Planned follow-up in a fully provisioned Torghut dev environment:
  - `uv sync --frozen --extra dev`
  - `uv run --frozen pyright --project pyrightconfig.json`
  - `uv run --frozen pyright --project pyrightconfig.alpha.json`
  - `uv run --frozen pyright --project pyrightconfig.scripts.json`
  - targeted tests for modified suites above.
