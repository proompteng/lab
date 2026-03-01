# Iteration 6 — DSPy runtime harden unknown-executor path and fail-closed test

## Scope
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
- `services/torghut/tests/test_llm_dspy_runtime.py`
- Iteration report: `artifacts/dspy-loop5/iteration-6.md`

## What changed
- Added a final runtime-level executor guard in `DSPyReviewRuntime.review()` before mode-specific branching:
  - Unknown executor values now always raise `DSPyRuntimeUnsupportedStateError("dspy_artifact_executor_unknown")`.
- Fixed the regression test for unknown artifact executor behavior:
  - Reworked `test_unknown_artifact_executor_is_blocking` to avoid mutating a typed dataclass value with unsupported string literals.
  - Uses a `SimpleNamespace` + `cast()` to model a corrupted manifest payload and assert fail-closed semantics.

## Validation
- `uv run --frozen --extra dev ruff check services/torghut/app/trading/llm/dspy_programs/runtime.py services/torghut/tests/test_llm_dspy_runtime.py services/torghut/tests/test_llm_review_engine.py services/torghut/tests/test_trading_pipeline.py`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.alpha.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.scripts.json`
- `cd services/torghut && uv run --frozen python -m unittest discover -s tests -p test_config.py -p test_llm_dspy_runtime.py -p test_llm_review_engine.py -p test_trading_pipeline.py`
