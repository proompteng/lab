# DSPy Jangar Runtime Productionization Iteration 2

- Date: 2026-03-01
- Repository: proompteng/lab
- Base branch: main
- Head branch: codex/torghut-p2-dspy-jangar-loop10-20260301b
- Priority ID: 0
- Artifact path: services/torghut/artifacts/dspy-production/notes

## Scope

- Promote DSPy runtime to first-class live execution only when explicit policy and artifact gates pass.
- Preserve deterministic Jangar OpenAI-compatible transport at `${JANGAR_BASE_URL}/openai/v1/chat/completions`.
- Reject implicit/unsafe base URL shapes instead of silently tolerating misconfiguration.
- Add regression coverage for live-path gating, endpoint resolution, and fallback boundaries.

## Changes made

- `services/torghut/app/config.py`
  - Hardened `Settings.llm_dspy_live_runtime_gate()` to require a present, valid `jangar_base_url`.
  - Added explicit rejection reasons:
    - `dspy_jangar_base_url_missing`
    - `dspy_jangar_base_url_invalid`
- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Added `_resolve_dspy_jangar_api_base()` that normalizes and validates `JANGAR_BASE_URL` before composing the completion endpoint.
  - Maintains final target as `${base}/openai/v1/chat/completions` while rejecting malformed paths/query/fragment inputs.
- `services/torghut/app/trading/llm/dspy_programs/modules.py`
  - Hardened `_coerce_dspy_api_base()` to validate URL shape and support:
    - root base URL (e.g. `https://jangar.local`)
    - `/openai/v1`
    - `/openai/v1/chat/completions`
  - Keeps path validation fail-closed for unsupported paths with `dspy_api_base_invalid`.
- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Added regression coverage for endpoint normalization and reject-on-invalid query/path inputs.
- `services/torghut/tests/test_llm_dspy_modules.py`
  - Added live-program rejection test for invalid API base path and positive path normalization coverage.
- `services/torghut/tests/test_config.py`
  - Added gate-boundary coverage for missing and invalid Jangar base URL.
- `services/torghut/tests/test_trading_pipeline.py`
  - Added/updated live pipeline gate tests to wire in explicit Jangar base URL and verify gate-block behavior when base URL is missing.

## Verification

- Formatting: `bunx oxfmt --check services/torghut/app services/torghut/tests`
  - Result: pass
- Syntax sanity: `python3 -m py_compile` on modified Python modules/tests
  - Result: pass
- Execution tests attempted:
  - `uv run --project services/torghut --frozen pytest services/torghut/tests/test_llm_dspy_runtime.py services/torghut/tests/test_llm_dspy_modules.py services/torghut/tests/test_config.py services/torghut/tests/test_trading_pipeline.py -k dspy`
  - Blocked: `uv` not installed in environment
  - `python3 -m pytest ...`
    - Blocked: `pytest` module not installed in environment

## Risk / rollback posture

- Live DSPy execution remains deterministic and fail-closed through existing `llm_dspy_live_runtime_gate()` semantics and existing `dspy_live_runtime_mode_not_active`/state reason codes.
- No changes were made to direct provider transport selection outside Jangar path normalization.
