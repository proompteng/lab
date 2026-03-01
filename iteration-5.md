# Iteration 5 — DSPy live path productionization with Jangar transport hardening

## Scope

- Promote DSPy runtime to live-path with explicit policy/artifact gating in scheduler decisions.
- Keep Jangar OpenAI-compatible endpoint wiring and harden DSPy transport/schema handling.
- Add regression coverage for runtime selection, endpoint construction, and fallback boundaries.
- Keep fail-closed semantics for unsupported DSPy states.

## Changes

- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Use resolved Jangar completion endpoint directly via `api_completion_url` when instantiating `LiveDSPyCommitteeProgram`.
  - Normalize and validate JANGAR base URL to `${JANGAR_BASE_URL}/openai/v1/chat/completions` with strict scheme/path checks.
  - Preserve fail-closed behavior via existing `DSPyRuntimeUnsupportedStateError` pathways.

- `services/torghut/app/trading/llm/dspy_programs/modules.py`
  - Keep API completion preference explicit in `_coerce_dspy_api_base` by letting `api_completion_url` win over `api_base`.
  - Keep transport coercion strict to OpenAI-compatible `/openai/v1` base and reject unsupported paths.
  - Reject non-dict `response_json` payloads during runtime decoding.

- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Extend coverage for Jangar completion endpoint resolution and API field wiring.
  - Ensure live program includes Jangar completion URL and leaves `api_base` unset when `api_completion_url` is used.

- `services/torghut/tests/test_llm_dspy_modules.py`
  - Add transport hardening tests for API completion precedence and invalid payload shape/paths.
  - Add regression test that schema responses must be dict-shaped for deterministic parsing.

- `services/torghut/tests/test_trading_pipeline.py`
  - Add/retain gate-boundary regression for DSPy live runtime blocking when rollout stage is not `stage3`.
  - Preserve fallback boundaries so no LLM review is attempted and bounded audit metadata is recorded.

## Verification

- `cd services/torghut && . .venv/bin/activate && python -m unittest tests.test_llm_dspy_modules tests.test_llm_dspy_runtime tests.test_config tests.test_trading_pipeline`
- `cd services/torghut && . .venv/bin/activate && ruff check app/trading/llm/dspy_programs/runtime.py app/trading/llm/dspy_programs/modules.py app/config.py tests/test_llm_dspy_runtime.py tests/test_llm_dspy_modules.py tests/test_trading_pipeline.py tests/test_config.py`
- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.scripts.json`
- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.json`

## Outcome

- Live-path DSPy now consumes Jangar via the explicit OpenAI-compatible completion URL and no longer relies on `api_base` as a transport path when completion URL is present.
- Deterministic guardrails remain in place: unsupported runtime state blocks live path and fallback outcomes remain bounded.
- Added regression coverage for stage-gate boundaries, endpoint construction, and payload schema hardening.
- Baseline static type-checking note: `pyright --project pyrightconfig.json` reports pre-existing unrelated errors in unchanged modules (`app/trading/execution_adapters.py`, `app/trading/order_feed.py`) in this environment.
