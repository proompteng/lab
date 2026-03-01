# Iteration 4 — DSPy live productionization hardening

## Scope

- Promote DSPy runtime to a first-class live path with explicit gate and artifact checks.
- Preserve Jangar-compatible transport at `${JANGAR_BASE_URL}/openai/v1/chat/completions` for live DSPy inference.
- Keep unsupported DSPy runtime states fail-closed and bounded through actuation guards.
- Add/update regression coverage for live path selection, Jangar endpoint resolution, and fallback boundaries.

## Changes

- `services/torghut/app/config.py`
  - Uses `llm_dspy_live_runtime_gate()` + artifact/rollout/state validation to control when live DSPy execution is permitted.
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Continues hardening of Jangar base-path normalization in `_resolve_dspy_api_base` / `_resolve_dspy_completion_url`.
  - Enforces unsupported executor states as hard fail conditions (`DSPyRuntimeUnsupportedStateError`) to prevent scaffold defaulting in live mode.
- `services/torghut/app/trading/scheduler.py`
  - Enforces policy-first live-gate checks before DSPy review execution and keeps deterministic veto behavior for unsupported live states.
- `services/torghut/app/trading/llm/client.py`
  - Keeps Jangar OpenAI-compatible endpoint handling and stream parsing hardening for legacy compatibility paths.
- `services/torghut/tests/test_llm_dspy_runtime.py`
- `services/torghut/tests/test_llm_jangar_client.py`
- `services/torghut/tests/test_trading_pipeline.py`
  - Regression coverage for Jangar endpoint path acceptance/rejection, live DSPy readiness/gate ordering, and fallback/unsupported-state boundaries.

## Verification

- `bunx oxfmt --check services/torghut/app services/torghut/tests`
- `gh pr checks 3818 --repo proompteng/lab`
- `python3 -m unittest tests.test_llm_dspy_runtime tests.test_llm_jangar_client tests.test_llm_review_engine`
  - Failed in this environment: missing `pydantic` runtime dependency for `torghut` tests.
- `cd services/torghut && uv run --frozen pytest tests/test_llm_dspy_runtime.py tests/test_llm_jangar_client.py tests/test_trading_pipeline.py`
  - Blocked in this environment: `uv: command not found`.

## Outcome

- DSPy live path now remains explicitly gated by runtime policy and artifact readiness checks.
- Jangar transport path semantics are preserved at `.../openai/v1/chat/completions` and rejected on malformed base URLs.
- Unsupported live runtime states retain deterministic fail-closed behavior with `veto`-style boundaries.
