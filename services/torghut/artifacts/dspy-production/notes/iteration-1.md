# DSPy Jangar Runtime Productionization Iteration 1

- Date: 2026-03-01
- Repository: proompteng/lab
- Base branch: main
- Head branch: codex/torghut-p2-dspy-jangar-loop10-20260301b
- Priority ID: 0
- Artifact path: services/torghut/artifacts/dspy-production/notes

## Scope

- Promote DSPy Jangar runtime execution toward explicit policy/gate-driven live selection.
- Preserve Jangar OpenAI-compatible pathing while preventing implicit fallback to direct/open defaults.
- Tighten transport/schema failure handling in `LiveDSPyCommitteeProgram`.
- Add regression coverage for live path selection assumptions and endpoint resolution.
- Add fallback boundary coverage for missing transport config.

## Changes made

- `services/torghut/app/trading/llm/dspy_programs/runtime.py`
  - Kept DSPy live path behind existing `llm_dspy_runtime_mode`/artifact semantics.
  - Updated Jangar API resolution helper to resolve the full chat-completion URL using
    `${JANGAR_BASE_URL}/openai/v1/chat/completions`.

- `services/torghut/app/trading/llm/dspy_programs/modules.py`
  - Added transport hardening in `LiveDSPyCommitteeProgram`:
    - normalizes incoming API base values so chat completion URLs are converted to the expected LM base form,
    - rejects missing/empty `api_base` values to avoid implicit provider fallback,
    - adds explicit JSON decode error handling for string/byte response payloads.

- Tests
  - `services/torghut/tests/test_llm_dspy_runtime.py`
    - added Jangar completion endpoint resolution regression tests.
- `services/torghut/tests/test_llm_dspy_modules.py`
  - added API base coercion and empty-base fail-fast regression tests.

## Verification

- Formatting: `bunx oxfmt --check services/torghut/app services/torghut/tests`
- Regression tests were not executed in this environment because `python`, `uv`, and local Python dependencies are unavailable.

## Gate/rollback posture

- Live path remains deterministic and fail-closed when unsupported runtime state is reached.
- Runtime execution still follows policy/rollback controls in scheduler-level guard logic.
