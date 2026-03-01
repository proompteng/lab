# Iteration 4 — Stabilize pipeline test defaults for default-off LLM execution path

## Scope
- Prevent legacy and scheduler-only tests from unintentionally entering LLM review paths due default runtime settings.
- Keep regression coverage focused on DSPy unsupported-state behavior and live path boundaries.

## What changed
- `services/torghut/tests/test_trading_pipeline.py`
  - `TestTradingPipeline.setUp` now captures and forces `settings.llm_enabled = False` for the whole test class.
  - `tearDown` restores the original `llm_enabled` value.
  - This isolates tests that are not explicitly about LLM review from the new DSPy-first runtime defaults and avoids non-deterministic failures in otherwise unrelated pipeline flows.

## Validation run
- `/tmp/torghut-venv/bin/python -m unittest discover -s tests -p "test_*.py"`
- `/tmp/torghut-venv/bin/python -m compileall app`
- `/tmp/torghut-venv/bin/ruff check app tests scripts migrations`
- `/tmp/torghut-venv/bin/pyright --project pyrightconfig.json` (fails in this environment due missing optional service deps and unresolved imports)
- `/tmp/torghut-venv/bin/pyright --project pyrightconfig.alpha.json` (fails in this environment due missing optional deps)
- `/tmp/torghut-venv/bin/pyright --project pyrightconfig.scripts.json` (fails in this environment due missing optional deps)

## Notes
- Full test suite now passes when using the provided dependency environment (`/tmp/torghut-venv`); local `python3` subprocess-based harnesses may fail without dependency-path setup because they resolve to system interpreter.
