# Iteration 5 — DSPy live hardening, Jangar endpoint conformance, and bounded fallback

## Scope

- Promote DSPy runtime to the explicit live path only when policy and artifact gates pass.
- Preserve Jangar-compatible OpenAI chat completion routing at `${JANGAR_BASE_URL}/openai/v1/chat/completions`.
- Remove implicit scaffold/default executor behavior from artifact manifest loading.
- Add regression coverage for live runtime selection, endpoint/path validation, and gate-boundary fallback behavior.

## Changes

- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Hardened `_load_manifest_from_db` to reject missing/blank `executor` metadata with `dspy_artifact_executor_missing` instead of defaulting to `heuristic`.

- `services/torghut/app/trading/scheduler.py`
  - Updated `_apply_llm_review` to evaluate `settings.llm_dspy_live_runtime_gate()` before any DSPy readiness probe.
  - Keeps explicit policy/artifact gating fail-closed and avoids runtime probing when gate is already denied.

- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added `test_missing_artifact_executor_field_is_rejected` to ensure manifest parsing fails when executor is absent.
  - Added `test_active_readiness_blocks_jangar_base_url_fragment` to enforce fragment path rejection for DSPy completion routing.

- `services/torghut/tests/test_llm_jangar_client.py`
  - Added `test_completion_request_rejects_invalid_jangar_base_url_query` to validate Jangar client refuses query-suffixed base URLs.

- `services/torghut/tests/test_trading_pipeline.py`
  - Added `test_pipeline_llm_dspy_live_runtime_gate_blocks_before_readiness_probe` to assert gate failure blocks DSPy live path before readiness probing and before review execution.

## Verification

- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
- `cd services/torghut && uv run --frozen pytest tests/test_llm_dspy_runtime.py tests/test_llm_jangar_client.py tests/test_trading_pipeline.py`

## Outcome

- DSPy live execution remains Jangar-compatible and explicit-policy-gated.
- Missing artifact executor metadata now fails deterministically instead of silently falling back to heuristic execution.
- Added regression coverage for gate ordering and URL normalization/validation boundaries.
