# Iteration 5 — DSPy live gate hardening and unsupported-state fail-closed boundaries

## Scope
- `services/torghut/app/config.py`
- `services/torghut/tests/test_config.py`
- `services/torghut/tests/test_trading_pipeline.py`
- Iteration report: `artifacts/dspy-loop5/iteration-5.md`

## What changed
- Added live-gate hash validation in `Settings.llm_dspy_live_runtime_gate()` to hard-fail bootstrap-oriented execution and malformed hash states before runtime construction:
  - Added explicit artifact hash format checks (`dspy_artifact_hash_invalid_length`, `dspy_artifact_hash_not_hex`).
  - Added explicit bootstrap artifact prohibition in active mode (`dspy_bootstrap_artifact_forbidden`).
- Added cache-backed helper `_dspy_bootstrap_artifact_hash()` in settings module to avoid importing runtime internals at module import time.
- Extended `test_config.py` coverage for DSPy gate rejection semantics:
  - `test_live_dspy_runtime_gate_blocks_invalid_hash`
  - `test_live_dspy_runtime_gate_blocks_bootstrap_artifact_hash`
- Extended `test_trading_pipeline.py` to assert live DSPy fallback boundaries in scheduler decision flow:
  - bootstrap hash is blocked by gate and never reaches `LLMReviewEngine`.
  - unsupported runtime errors remain veto-only in live, even under configured pass-through guardrail settings.

## Validation
- `uv run --frozen --extra dev ruff check services/torghut/app/config.py services/torghut/tests/test_config.py services/torghut/tests/test_llm_dspy_runtime.py services/torghut/tests/test_trading_pipeline.py`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.alpha.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.scripts.json`
- `cd services/torghut && uv run --frozen python -m unittest discover -s tests -p test_config.py -p test_llm_dspy_runtime.py -p test_trading_pipeline.py`
