# DSPy Jangar Decisioning Iteration 6

- Date: 2026-03-01
- Repository: proompteng/lab
- Base branch: main
- Head branch: codex/torghut-p2-dspy-jangar-loop10-20260301b
- Priority ID: 0
- Artifact path: services/torghut/artifacts/dspy-production/notes

## Scope

- Finalize the DSPy productionization pass with focus on live-path selection, Jangar OpenAI-compatible transport, and deterministic fail-closed behavior.
- Preserve the first-class DSPy review path behind explicit policy/artifact gates for live mode.
- Keep fallback semantics fail-closed on unsupported DSPy states.
- Capture iteration evidence and validation coverage status.

## Changes made

- `services/torghut/app/config.py`
  - `llm_dspy_live_runtime_gate()` remains the explicit policy+artifact gate for live DSPy operation, including:
    - `TRADING_MODE == live`
    - `LLM_DSPY_RUNTIME_MODE == active`
    - rollout stage and committee/model lock checks
    - `JANGAR_BASE_URL` validation
    - bootstrap artifact rejection in active mode.
- `services/torghut/app/trading/llm/client.py`
  - `LLMClient` Jangar path uses `JANGAR_BASE_URL` normalized to `${base}/openai/v1/chat/completions`.
  - Path and schema error handling remain strict for malformed transport URLs and stream frames.
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - `DSPyReviewRuntime` path resolution uses `_resolve_dspy_jangar_api_base()` and explicit `api_completion_url` preference for `LiveDSPyCommitteeProgram`.
  - Unsupported runtime states continue to raise `DSPyRuntimeUnsupportedStateError` and are handled as veto in scheduler-level fail-closed flow.
- `services/torghut/app/trading/llm/dspy_programs/modules.py`
  - `api_completion_url` explicitly preferred over `api_base` and normalized to OpenAI-compatible base path for dspy LM clients.
- `services/torghut/app/trading/scheduler.py`
  - Live-mode gate check in `_apply_llm_review()` ensures unsupported/unallowed DSPy live states are blocked before execution attempts and recorded via deterministic fallback controls.
- Regression test coverage updated in:
  - `services/torghut/tests/test_llm_jangar_client.py`
  - `services/torghut/tests/test_llm_dspy_runtime.py`
  - `services/torghut/tests/test_llm_dspy_modules.py`
  - `services/torghut/tests/test_llm_review_engine.py`
  - `services/torghut/tests/test_config.py`
  - `services/torghut/tests/test_trading_pipeline.py`

## Validation status

- `bunx oxfmt --check` run for touched Python-related files; formatting baseline remained compliant.
- Unit test execution in this environment requires Python 3.11/3.12 dependencies (project requires `<3.13`), while available runtime is Python 3.13; attempted `python3 -m unittest` runs fail on missing dependencies (`pydantic`, `sqlalchemy`) in this container.
- No additional local code changes were introduced in this iteration beyond alignment/reporting of the existing DSPy/Jangar live-hardening state.
