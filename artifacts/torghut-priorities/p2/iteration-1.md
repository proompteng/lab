# Iteration 1

## Summary
- Promoted DSPy runtime to an explicit live-first-class path in active mode with gate and artifact readiness checks.
- Preserved Jangar compatibility by continuing to use `JANGAR_BASE_URL/openai/v1/chat/completions` and validating endpoint behavior in tests.
- Hardened live-path decisioning so unsupported runtime states fail-closed before LLM review execution.
- Reduced legacy scaffold default usage by introducing explicit readiness gating and adding regression coverage.

## Changes made
- Added `DSPyReviewRuntime.evaluate_live_readiness()` to return deterministic readiness reasons.
- Updated `DSPyReviewRuntime.review()` to fail closed in active mode unless live readiness passes.
- Added scheduler-level active-mode gate: `llm_dspy_live_runtime_gate` plus readiness check, with `llm_dspy_live_runtime_gate_blocked` outcome on block.
- Hardened Jangar client behavior to not fall back to self-hosted in live trading mode.
- Added/updated regression tests for:
  - Jangar endpoint path and headers.
  - Live DSPy readiness acceptance/rejection.
  - Live DSPy readiness blocking in scheduler flows and fallback boundaries.
  - Scheduler path allowing live review only when readiness is explicitly true.

## Validation
- `PYTHONPATH=. python3 -m unittest tests.test_llm_dspy_runtime tests.test_llm_jangar_client tests.test_trading_pipeline`
- `ruff check app/config.py app/trading/decisions.py app/trading/scheduler.py app/trading/llm/client.py app/trading/llm/dspy_programs/runtime.py tests/test_llm_dspy_runtime.py tests/test_llm_jangar_client.py tests/test_trading_pipeline.py`
- `pyright --project pyrightconfig.json`
- `pyright --project pyrightconfig.alpha.json`
- `pyright --project pyrightconfig.scripts.json`

