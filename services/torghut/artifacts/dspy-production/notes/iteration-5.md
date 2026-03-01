# DSPy Jangar Decisioning Iteration 5

- Date: 2026-03-01
- Repository: proompteng/lab
- Base branch: main
- Head branch: codex/torghut-p2-dspy-jangar-loop10-20260301b
- Priority ID: 0
- Artifact path: services/torghut/artifacts/dspy-production/notes

## Scope

- Productionize DSPy live inference transport hardening against malformed Jangar base URLs.
- Preserve Jangar OpenAI-compatible endpoint semantics at `${JANGAR_BASE_URL}/openai/v1/chat/completions`.
- Keep fail-closed behavior for unsupported live runtime states.
- Add regression tests for endpoint normalization, selection of the `dspy_live` runtime path, and runtime fallback boundaries.

## Changes made

- `services/torghut/app/trading/llm/client.py`
  - Added `_resolve_dspy_jangar_completion_url()` helper to normalize and validate `JANGAR_BASE_URL`.
  - Enforces OpenAI-compatible path shape and prevents malformed values:
    - accepts base host only, `/openai/v1`, or `/openai/v1/chat/completions`
    - rejects missing scheme/netloc and URL query/fragment
  - `LLMClient._request_review_via_jangar()` now always sends requests to the normalized `.../openai/v1/chat/completions` endpoint.

- `services/torghut/tests/test_llm_jangar_client.py`
  - Added regression checks for endpoint normalization and rejection of invalid Jangar base URLs.
  - Added regression check confirming `_request_review_via_jangar()` sends to normalized endpoint (no double-append when base URL already contains `/chat/completions`).

- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added regression check that active DSPy mode routes runtime review through a live (`dspy_live`) manifest path and returns live metadata in successful review flow.

## Validation status

- Added targeted regression tests in the following files:
  - `services/torghut/tests/test_llm_jangar_client.py`
  - `services/torghut/tests/test_llm_dspy_runtime.py`

- Existing gate/fail-closed protections remain covered in:
  - `services/torghut/tests/test_config.py`
  - `services/torghut/tests/test_llm_review_engine.py`
  - `services/torghut/tests/test_trading_pipeline.py`
