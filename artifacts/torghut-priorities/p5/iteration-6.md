# Iteration 6 — DSPy live path hardening for Jangar transport and gate boundaries

## Scope

- Replace synthetic fallback gate inputs with artifact-derived evidence in autonomy and DSPy promotion surfaces.
- Harden DSPy/Jangar live path behavior for malformed URLs and fail-closed transitions.
- Preserve deterministic promotion boundaries when dependent evidence is missing, stale, or untrusted.

## Changes

- `services/torghut/app/trading/autonomy/lane.py`
  - Updated fragility gate input extraction to avoid synthetic crisis fallbacks.
  - Enforced fail-closed behavior returning `not_measured` states and zero-violence defaults when inputs are unavailable.
  - Preserved dependent metric ordering while allowing missing TCA values to surface as `None`.

- `services/torghut/app/trading/tca.py`
  - Updated `build_tca_gate_inputs` to keep aggregate metrics `None` when dependencies are missing instead of coercing to zero.

- `services/torghut/app/trading/llm/dspy_compile/workflow.py`
  - Expanded promotion evidence override key handling to include `evalReportRef`.
  - Reworked promotion evidence resolution to validate artifact-root canonical references before submission.
  - Dropped synthetic/override inputs from promote payloads so downstream execution requires artifact evidence.

- `services/torghut/app/trading/autonomy/policy_checks.py`
  - Enforced invalid Janus evidence schema as a hard blocker for promotion prerequisites.

- `services/torghut/tests/test_autonomous_lane.py`
  - Updated fragility fallback regressions for `not_measured` and fail-closed defaults.
  - Added stale/missing dependency coverage.

- `services/torghut/tests/test_llm_dspy_workflow.py`
  - Added non-canonical `evalReportRef` rejection coverage in promotion path.
  - Preserved assertions that synthetic/override inputs are removed before AgentRun submission.

- `services/torghut/tests/test_policy_checks.py`
  - Added Janus schema invalidation regression for promotion preconditions.

- `services/torghut/tests/test_config.py`
  - Added `test_live_dspy_runtime_gate_blocks_jangar_path_with_query_or_fragment` for gate-level URL hardening.

- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Expanded fragment/query rejection cases for `resolve_dspy_api_base`.

- `services/torghut/tests/test_llm_dspy_modules.py`
  - Added completion URL coercion tests for query/fragment rejection.

## Verification

- `uv run --frozen pytest services/torghut/tests/test_config.py services/torghut/tests/test_llm_dspy_runtime.py services/torghut/tests/test_llm_dspy_modules.py`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.alpha.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.scripts.json`
- `python3 -m unittest services/torghut/tests/test_autonomous_lane.py services/torghut/tests/test_llm_dspy_workflow.py services/torghut/tests/test_policy_checks.py` *(environment dependent; fails when `sqlalchemy`/`uv` tooling unavailable)*
