# Iteration 5 — DSPy live hardening, Jangar transport compatibility, and bounded fallback

## Scope

- Promote DSPy runtime to the explicit live path only when policy and artifact gates pass.
- Preserve Jangar-compatible OpenAI chat completion routing at `${JANGAR_BASE_URL}/openai/v1/chat/completions`.
- Remove implicit scaffold/default executor behavior from artifact manifest loading.
- Add regression coverage for live runtime selection, endpoint/path validation, and rollout-stage boundaries.

## Changes

- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Hardened `_load_manifest_from_db` to reject missing/blank `executor` metadata with `dspy_artifact_executor_missing` instead of defaulting to `heuristic`.
  - Uses resolved Jangar completion endpoint via `api_completion_url` for live DSPy and normalizes base-path handling.

- `services/torghut/app/trading/scheduler.py`
  - Updated `_apply_llm_review` to evaluate `settings.llm_dspy_live_runtime_gate()` before any DSPy readiness probe.
  - Keeps explicit policy/artifact gating fail-closed and avoids runtime probing when gate is already denied.

- `services/torghut/app/trading/llm/dspy_programs/modules.py`
  - Keep transport coercion strict to OpenAI-compatible `/openai/v1` and reject unsupported paths.
  - Let `api_completion_url` win over `api_base` and reject non-dict `response_json` payloads during runtime decoding.

- `services/torghut/tests/test_config.py`
  - Preserved runtime/config regressions impacted by Jangar transport changes.

- `services/torghut/tests/test_llm_dspy_modules.py`
  - Added transport hardening for API completion precedence and payload shape validation.

- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added `test_missing_artifact_executor_field_is_rejected`.
  - Added readiness and URL-fragment validation tests for Jangar routing.
  - Extended coverage for API completion wiring and Jangar endpoint construction.

- `services/torghut/tests/test_llm_jangar_client.py`
  - Added `test_completion_request_rejects_invalid_jangar_base_url_query` for query-suffixed base URL rejection.

- `services/torghut/tests/test_trading_pipeline.py`
  - Added/retained regressions for live runtime gating boundaries and readiness fallback:
    - `test_pipeline_llm_dspy_live_runtime_readiness_blocked_without_dspy_live_artifact`
    - `test_pipeline_llm_dspy_live_runtime_gate_blocks_when_stage_not_stage3`
    - `test_pipeline_llm_dspy_live_runtime_gate_blocked_in_live`

## Verification

- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
- `cd services/torghut && uv run --frozen pytest tests/test_config.py tests/test_llm_dspy_modules.py tests/test_llm_dspy_runtime.py tests/test_llm_jangar_client.py tests/test_trading_pipeline.py`

## Outcome

- DSPy live execution remains Jangar-compatible and explicit-policy-gated.
- Missing artifact executor metadata now fails deterministically instead of silently falling back to heuristic execution.
- Added regression coverage for gate ordering, endpoint construction/validation, and payload schema hardening.
