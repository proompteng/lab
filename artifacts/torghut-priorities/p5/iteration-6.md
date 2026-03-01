# Iteration 6 — DSPy live path regression hardening for Jangar transport and gate boundaries

## Scope

- Add targeted regression coverage for Jangar endpoint normalization edge cases in DSPy runtime and transport helpers.
- Ensure `llm_dspy_live_runtime_gate` rejects malformed Jangar URLs with query/fragment values.
- Keep live-path fail-closed behavior explicit in unsupported-state boundaries.

## Changes

- `services/torghut/tests/test_config.py`
  - Added `test_live_dspy_runtime_gate_blocks_jangar_path_with_query_or_fragment` to enforce gate-level rejection when `JANGAR_BASE_URL` includes query/fragment components.

- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Expanded `test_resolve_dspy_api_base_requires_jangar_base_url` to assert fragment-bearing completion URLs are rejected.

- `services/torghut/tests/test_llm_dspy_modules.py`
  - Added `test_coerce_rejects_completion_urls_with_query_or_fragment` to cover transport URL coercion hardening for `LiveDSPyCommitteeProgram` base candidates.

## Verification notes

- Planned runtime checks focused on the touched torghut DSPy/Jangar surfaces:
  - `uv run --frozen pytest services/torghut/tests/test_config.py services/torghut/tests/test_llm_dspy_runtime.py services/torghut/tests/test_llm_dspy_modules.py`
  - `uv run --frozen pyright --project services/torghut/pyrightconfig.json`
  - `uv run --frozen pyright --project services/torghut/pyrightconfig.alpha.json`
  - `uv run --frozen pyright --project services/torghut/pyrightconfig.scripts.json`
