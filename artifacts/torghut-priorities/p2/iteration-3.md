# Iteration 3

## Summary
- Promoted DSPy to a deterministic, policy-gated live path by validating readiness inside `DSPyReviewRuntime` and relying on that gate in scheduler integration.
- Preserved Jangar OpenAI-compatible transport semantics for both DSPy runtime wiring and direct Jangar LLM requests, with normalized base-path handling for `/openai/v1` and `/openai/v1/chat/completions` inputs.
- Added regression coverage for live DSPy endpoint resolution, runtime readiness boundaries, and Jangar URL normalization to avoid scaffold-heavy fallback behavior becoming the default live path.

## Changes made
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Hardened `_resolve_dspy_api_base()` to parse/validate `JANGAR_BASE_URL` and normalize path handling by stripping `chat/completions` suffixes and avoiding duplicate `/openai/v1` segments.
  - Kept `_resolve_dspy_completion_url()` anchored to `<base>/openai/v1/chat/completions`.
  - `evaluate_live_readiness()` now applies `settings.llm_dspy_live_runtime_gate()` when `trading_mode == "live"`, preserving deterministic fail-closed behavior while enforcing policy/artifact readiness before live execution.
- `services/torghut/app/trading/llm/client.py`
  - Added Jangar completion URL normalizer with same path-safety rules.
  - `_request_review_via_jangar()` now uses the normalized helper URL instead of raw concatenation.
- `services/torghut/app/trading/scheduler.py`
  - Removed duplicate pre-check for `settings.llm_dspy_live_runtime_gate()` so live eligibility is centralized in runtime readiness and scheduler keeps one decision gate.
- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added assertions for normalized base-path handling when Jangar base URL is `openai/v1` or `openai/v1/chat/completions`.
- `services/torghut/tests/test_llm_jangar_client.py`
  - Added endpoint-normalization regression for `_request_review_via_jangar` with a base URL containing `openai/v1/chat/completions`.

## Validation
- `cd /workspace/lab/services/torghut && PYTHONPATH=/workspace/lab/services/torghut python3 -m unittest tests.test_llm_dspy_runtime tests.test_llm_jangar_client -v`
  - Passed: 23 tests
- `cd /workspace/lab/services/torghut && ruff check app/trading/llm/dspy_programs/runtime.py app/trading/llm/client.py tests/test_llm_dspy_runtime.py tests/test_llm_jangar_client.py`
  - Passed
- `cd /workspace/lab/services/torghut && pyright --project pyrightconfig.json && pyright --project pyrightconfig.alpha.json && pyright --project pyrightconfig.scripts.json`
  - Fails in pre-existing files:
    - `app/trading/execution_adapters.py`: 2 reported unknown-variable errors
    - `app/trading/order_feed.py`: 1 reported unknown-variable error
