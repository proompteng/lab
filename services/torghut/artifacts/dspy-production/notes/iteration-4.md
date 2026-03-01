# DSPy Jangar Decisioning Iteration 4

- Date: 2026-03-01
- Repository: proompteng/lab
- Base branch: main
- Head branch: codex/torghut-p2-dspy-jangar-loop10-20260301b
- Priority ID: 0
- Artifact path: services/torghut/artifacts/dspy-production/notes

## Scope

- Productionize DSPy live decisioning under explicit policy/gating constraints.
- Ensure Jangar OpenAI-compatible completion endpoint handling remains hardcoded to `/openai/v1/chat/completions`.
- Tighten DSPy transport schema normalization so non-OpenAI base paths do not silently pass through.
- Preserve deterministic fail-closed behavior for unsupported DSPy runtime states.
- Add regression coverage around transport normalization and endpoint path handling.

## Changes made

- `services/torghut/app/trading/llm/dspy_programs/modules.py`
  - Hardened `_coerce_dspy_api_base()` so host-only values now normalize to `.../openai/v1` instead of passing through unchanged.
  - Continued to accept `/openai/v1` and `/openai/v1/chat/completions` and reject invalid query/fragment/scheme/path combinations.

- `services/torghut/tests/test_llm_dspy_modules.py`
  - Updated transport hardening regression assertion in `test_coerce_accepts_base_or_completion_paths`:
    - `https://jangar.openai.local` now resolves to `https://jangar.openai.local/openai/v1`.

- `services/torghut/app/trading/llm/dspy_programs/runtime.py` and surrounding control flow
  - No functional change in this pass; existing live-mode gate and runtime path-selection behavior remains as-is, including:
    - active-mode enforcement of `dspy_live` executor,
    - explicit `JANGAR_BASE_URL` compatibility checks,
    - deterministic unsupported-state exceptions bubbled to scheduler for fail-closed behavior.

## Validation/Regression status

- Verified existing DSPy live-path, gate, and fail-closed tests remain in place:
  - `services/torghut/tests/test_llm_dspy_runtime.py`
  - `services/torghut/tests/test_config.py`
  - `services/torghut/tests/test_trading_pipeline.py`
  - `services/torghut/tests/test_llm_review_engine.py`
- Added transport-path normalization regression update in `test_llm_dspy_modules.py` for Jangar-compatible base normalization.
