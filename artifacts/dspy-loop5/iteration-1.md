# Iteration 1 — DSPy live gate hardening

## Scope
- Promoted DSPy execution to a gated live path in torghut trading runtime and scheduler decisions.
- Tightened fallback and compatibility checks so unsupported runtime states fail closed.
- Added regression coverage for unsupported-state transitions and fallback boundaries.

## What changed
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Added `DSPyRuntimeUnsupportedStateError` and wired it into `review()` and manifest loading paths.
  - Enforced active/runtime bootstrap hash guardrails and explicit compatibility checks.
  - Required manifest fields now include reproducibility metadata; invalid hashes, signatures, or missing compatibility no longer silently fall back.
- `services/torghut/app/trading/llm/dspy_programs/__init__.py`
  - Re-exported new unsupported-state error class so integration layers can fail closed correctly.
- `services/torghut/app/trading/llm/review_engine.py`
  - Propagated runtime mode into deterministic fallback metadata and re-raised unsupported-state errors instead of collapsing them to generic fallback.
- `services/torghut/app/trading/scheduler.py`
  - Added unsupported-state handling in LLM review error path so invalid live runtime state vetoes decision execution.
- `services/torghut/app/config.py`
  - Updated runtime-mode comment context for live/disabled/bootstrap behavior.

## Runtime pathing and actuation guards
- DSPy is now treated as first-class only when:
  - runtime mode policy is `live`
  - artifact hash and compatibility are present and valid
  - bootstrap is explicitly allowed by active/runtime mode contract
- Unsupported states now fail closed through `DSPyRuntimeUnsupportedStateError` and result in `ReviewResult` veto decisions.

## Tests added
- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added coverage for:
    - disabled runtime mode rejection
    - missing artifact hash and active bootstrap hash policy mismatch
    - manifest metadata/signature compatibility failures
- `services/torghut/tests/test_llm_review_engine.py`
  - Added regression asserting unsupported-state errors are re-raised rather than treated as recoverable fallbacks.
- `services/torghut/tests/test_trading_pipeline.py`
  - Added decision-flow regression ensuring unsupported runtime state vetoes execution and does not execute the trading payload.

## Validation run
- `python3 -m unittest tests.test_llm_dspy_runtime tests.test_llm_review_engine tests.test_trading_pipeline`
- `ruff check services/torghut/app/trading/llm/dspy_programs/runtime.py services/torghut/app/trading/llm/dspy_programs/__init__.py services/torghut/app/trading/llm/review_engine.py services/torghut/app/trading/scheduler.py services/torghut/app/config.py services/torghut/tests/test_llm_dspy_runtime.py services/torghut/tests/test_llm_review_engine.py services/torghut/tests/test_trading_pipeline.py`
- `pyright services/torghut/app/trading/llm/dspy_programs/runtime.py services/torghut/app/trading/llm/dspy_programs/__init__.py services/torghut/app/trading/llm/review_engine.py services/torghut/app/trading/scheduler.py services/torghut/app/config.py services/torghut/tests/test_llm_dspy_runtime.py services/torghut/tests/test_llm_review_engine.py services/torghut/tests/test_trading_pipeline.py`
