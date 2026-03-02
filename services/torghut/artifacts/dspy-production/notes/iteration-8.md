# DSPy Jangar Productionization Iteration 8

- Date: 2026-03-01
- Repository: proompteng/lab
- Base branch: main
- Head branch: codex/torghut-p2-dspy-jangar-loop10-20260301b
- Priority ID: 0
- Artifact path: services/torghut/artifacts/dspy-production/notes

## Scope

- Promote DSPy runtime to a first-class live decision path only when explicit policy/artifact gate checks pass.
- Keep the Jangar OpenAI-compatible endpoint path for DSPy transport (`/openai/v1/chat/completions`).
- Preserve deterministic fail-closed behavior for unsupported DSPy runtime states and make fallback boundaries explicit in tests.

## Changes made

- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Added explicit live gate enforcement in `DSPyReviewRuntime.review()` for `mode == "active"` via `settings.llm_dspy_live_runtime_gate()`.
  - Added `_require_live_runtime_gate()` to fail closed with `dspy_live_runtime_gate_blocked:<reasons>` before artifact loading/dispatch.
- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added deterministic runtime-gate helpers to set/restore live-policy state for tests.
  - Added regression test asserting active runtime review is blocked when live gate conditions fail.
  - Updated active-mode tests to configure gate prerequisites so live-path assertions target the intended failure mode boundaries.

## Validation

- `bunx oxfmt --check services/torghut/app services/torghut/tests` -> pass
- `python3 -m py_compile services/torghut/app/trading/llm/dspy_programs/runtime.py services/torghut/tests/test_llm_dspy_runtime.py` -> pass
- `python3 -m unittest tests/test_llm_dspy_runtime.py` (with `PYTHONPATH=.`, in virtualenv) -> pass
- `python3 -m unittest tests/test_config.py tests/test_llm_dspy_modules.py tests/test_llm_review_engine.py` (with `PYTHONPATH=.`, in virtualenv) -> pass
- `python3 -m unittest tests.test_trading_pipeline` (with `PYTHONPATH=.`, in virtualenv) -> pass
- `ruff check app/trading/llm/dspy_programs/runtime.py tests/test_llm_dspy_runtime.py tests/test_llm_dspy_modules.py tests/test_config.py tests/test_llm_review_engine.py tests/test_trading_pipeline.py` -> pass
- `pyright --project pyrightconfig.json` -> 3 pre-existing errors in unrelated files (`execution_adapters.py`, `order_feed.py`)
- `pyright --project pyrightconfig.alpha.json` -> pass
- `pyright --project pyrightconfig.scripts.json` -> pass
