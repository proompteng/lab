# Iteration 2

## Summary
- Promoted DSPy live usage to an explicit, policy-gated path by hardening transport checks and manifest readiness validation during live readiness evaluation.
- Preserved the required Jangar OpenAI-compatible endpoint by normalizing `JANGAR_BASE_URL` and forcing `/{openai/v1}/chat/completions` usage in DSPy live invocation.
- Reduced implicit fallback behavior in live mode by rejecting missing/invalid Jangar transport configuration and missing model/base values before runtime execution.
- Added regression tests that lock in live-path selection, endpoint shape, schema/runtime guards, and unsupported-state boundaries.

## Changes made
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Added `_resolve_dspy_api_base()` URL hardening: trims base formatting, rejects missing host/scheme/query/fragment, strips accidental `/openai/v1` suffixes, and normalizes to `<scheme>://<host>[:port]/openai/v1`.
  - Added `_resolve_dspy_completion_url()` and used it in live-readiness checks so transport schema cannot silently diverge from `openai/v1/chat/completions`.
  - Wired live readines check to validate model and transport schema before manifest/program checks.
- `services/torghut/app/trading/llm/dspy_programs/modules.py`
  - Added hard-fail guard for missing `api_base` in `LiveDSPyCommitteeProgram`.
  - Live DSPy now raises an explicit unsupported state-style runtime error when transport base is not configured.
- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added regression coverage for:
    - active readiness blocking on malformed Jangar base URLs (query/path/scheme).
    - completion URL resolution to `.../openai/v1/chat/completions`.
    - live program initialization receiving normalized Jangar base path.
  - Fixed probe test typing/import alignment for deterministic runtime initialization checks.

## Validation
- `cd /workspace/lab && /workspace/lab/services/torghut/.venv/bin/pip install fastapi uvicorn pydantic pydantic-settings sqlalchemy psycopg psycopg-binary alpaca-py pandas numpy openai dspy-ai kafka-python lz4 alembic pyyaml inngest pyright ruff`
- `cd /workspace/lab && /workspace/lab/services/torghut/.venv/bin/ruff check services/torghut/app/trading/llm/dspy_programs/runtime.py services/torghut/app/trading/llm/dspy_programs/modules.py services/torghut/tests/test_llm_dspy_runtime.py`
- `cd /workspace/lab && /workspace/lab/services/torghut/.venv/bin/pyright --project services/torghut/pyrightconfig.json`
- `cd /workspace/lab && /workspace/lab/services/torghut/.venv/bin/pyright --project services/torghut/pyrightconfig.alpha.json`
- `cd /workspace/lab && /workspace/lab/services/torghut/.venv/bin/pyright --project services/torghut/pyrightconfig.scripts.json`
- `cd /workspace/lab/services/torghut && PYTHONPATH=/workspace/lab/services/torghut /workspace/lab/services/torghut/.venv/bin/python -m unittest tests.test_llm_dspy_runtime -v`
