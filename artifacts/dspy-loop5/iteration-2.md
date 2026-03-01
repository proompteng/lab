# Iteration 2 — DSPy live gate enforcement at decision boundary

## Scope
- Enforce DSPy live runtime eligibility in scheduler before LLM review execution.
- Keep unsupported runtime states fail-closed with explicit fallback-to-veto behavior.
- Add regression tests for live gate path selection and blocked boundaries.

## What changed
- `services/torghut/app/trading/scheduler.py`
  - Added `llm_dspy_runtime_mode == "active"` gate check in `_apply_llm_review` using `settings.llm_dspy_live_runtime_gate()`.
  - Added `_handle_llm_dspy_live_runtime_block(...)` to enforce deterministic veto semantics with `effective_fail_mode="veto"` when gate checks fail.
  - Ensured live gate failures persist audit trail via standard `_handle_llm_unavailable` path and `llm_dspy_live_runtime_gate_blocked` reason.
- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added regression for active mode rejecting non-live manifest executors (`dspy_active_mode_requires_dspy_live_executor`).
- `services/torghut/tests/test_trading_pipeline.py`
  - Added `CountingLLMReviewEngine` test helper.
  - Added `test_pipeline_llm_dspy_live_runtime_gate_allows_live_path` to assert active DSPy live mode can run when gate conditions pass.
  - Added `test_pipeline_llm_dspy_live_runtime_gate_blocked_in_live` to assert blocked live gate short-circuits review execution and vetoes trade.

## Validation
- `python3 -m unittest services/torghut/tests/test_llm_dspy_runtime.py`
- `python3 -m unittest services/torghut/tests/test_trading_pipeline.py::TestTradingPipeline.test_pipeline_llm_dspy_live_runtime_gate_allows_live_path services/torghut/tests/test_trading_pipeline.py::TestTradingPipeline.test_pipeline_llm_dspy_live_runtime_gate_blocked_in_live services/torghut/tests/test_trading_pipeline.py::TestTradingPipeline.test_pipeline_llm_unsupported_runtime_state_vetoes_decision`
- `python3 -m unittest services/torghut/tests/test_llm_dspy_runtime.py services/torghut/tests/test_trading_pipeline.py`
