# Iteration 3 — Fail-closed unsupported DSPy state in shadow mode

## Scope
- Hardened decision-path failure semantics so unsupported DSPy runtime states always fail closed, even when shadow-mode pathways are enabled.
- Added a focused live-path regression that locks in the fail-closed boundary with explicit DSPy runtime errors.

## What changed
- `services/torghut/app/trading/scheduler.py`
  - Updated `_handle_llm_review_error` to treat `DSPyRuntimeUnsupportedStateError` as an unconditional fail-closed path.
  - For unsupported states, policy resolution now resolves to effective fail mode `veto`.
  - Added explicit guardrail-bypass override so shadow mode no longer permits a pass-through when the runtime state is unsupported.
- `services/torghut/tests/test_trading_pipeline.py`
  - Added `test_pipeline_llm_unsupported_runtime_state_vetoes_decision_in_shadow_mode`.
  - The new test validates a live active DSPy path with an unsupported runtime error and confirms:
    - review decision persisted as `error` with `fallback=veto`
    - no execution is submitted
    - engine review is invoked once

## Validation run
- `/tmp/torghut-venv/bin/python -m unittest services/torghut/tests/test_trading_pipeline.py::TestTradingPipeline.test_pipeline_llm_unsupported_runtime_state_vetoes_decision_in_shadow_mode`
- `/tmp/torghut-venv/bin/python -m unittest services/torghut/tests/test_trading_pipeline.py::TestTradingPipeline.test_pipeline_llm_dspy_live_runtime_gate_allows_live_path services/torghut/tests/test_trading_pipeline.py::TestTradingPipeline.test_pipeline_llm_dspy_live_runtime_gate_blocked_in_live services/torghut/tests/test_trading_pipeline.py::TestTradingPipeline.test_pipeline_llm_unsupported_runtime_state_vetoes_decision`
- `/tmp/torghut-venv/bin/ruff check services/torghut/app/trading/scheduler.py services/torghut/tests/test_trading_pipeline.py`

## Checkset attempts with environment notes
- `/tmp/torghut-venv/bin/pyright --project pyrightconfig.json` (fails: extensive existing `reportMissingImports` and unknown-type diagnostics across service; likely environment/dependency bootstrap issue)
- `/tmp/torghut-venv/bin/pyright --project pyrightconfig.alpha.json` (fails: missing type deps such as `pandas`)
- `/tmp/torghut-venv/bin/pyright --project pyrightconfig.scripts.json` (fails: missing deps e.g. `psycopg`, `sqlalchemy`, plus existing typing diagnostics)
