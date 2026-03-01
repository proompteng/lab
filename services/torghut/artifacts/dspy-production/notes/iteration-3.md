# DSPy Jangar Runtime Productionization Iteration 3

- Date: 2026-03-01
- Repository: proompteng/lab
- Base branch: main
- Head branch: codex/torghut-p2-dspy-jangar-loop10-20260301b
- Priority ID: 0
- Artifact path: services/torghut/artifacts/dspy-production/notes

## Scope

- Align runtime and configuration validation for Jangar compatibility paths.
- Extend DSPy/Jangar regression coverage for accepted endpoint shapes and explicit gate acceptance.
- Continue fail-closed DSPy unsupported-state behavior and live path gating where policy and artifacts permit.

## Changes made

- `services/torghut/app/config.py`
  - Relaxed `Settings.llm_dspy_live_runtime_gate()` URL shape checks for `JANGAR_BASE_URL`.
  - The gate now accepts:
    - bare host/authority paths (`http://jangar/`)
    - `/openai/v1`
    - `/openai/v1/chat/completions`
  - Rejects only unsupported schemes, fragments/queries, and unrelated paths.

- `services/torghut/tests/test_config.py`
  - Added `test_live_dspy_runtime_gate_allows_openai_compatible_jangar_base_url`.
  - Verifies live gate no longer rejects OpenAI-compatible Jangar base paths at `/openai/v1` and `/openai/v1/chat/completions` when other required gates are satisfied.

- `services/torghut/tests/test_llm_dspy_runtime.py`
  - Expanded resolution regression coverage for `_resolve_dspy_api_base()` to include `/openai/v1` and `/openai/v1/chat/completions` inputs.

## Validation notes

- Formatting/ABI checks run against changed scope were not yet executed at this stage in this pass.
- Regression intent remains focused on:
  - Jangar endpoint normalization to `${JANGAR_BASE_URL}/openai/v1/chat/completions`
  - config/runtime gate consistency for live DSPy selection
  - preserved fail-closed behavior for unsupported state transitions.
