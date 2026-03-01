# Iteration 5 — Router/HMM fail-closed governance expansion

## Scope

- Close remaining governance edge cases for scheduler/HMM integration in execution-critical paths.
- Ensure safe migration behavior remains intact while tightening decision-context payload contracts.
- Expand regression coverage for regime fallback and transition handling.

## Changes

- `services/torghut/tests/test_decisions.py`
  - Added regression test confirming legacy decision params omit synthetic `regime_hmm` payloads when no explicit regime context is present.
  - Kept route label derivation behavior intact, ensuring trend/range fallbacks still populate for legacy inputs.

- `services/torghut/tests/test_scheduler_regime_resolution.py`
  - Added test coverage for `fallback_to_defensive` guardrail handling in `regime_context_authority_reason` resolution.
  - Verified fallback path prefers nested legacy regime labels while preserving reason propagation for non-authoritative HMM input.

- `services/torghut/tests/test_trading_pipeline.py`
  - Added direct runtime gate unit test for `fallback_to_defensive` to assert fail-closed `abstain` behavior and source/reason metadata.

## Verification

- Updated unit tests targeting:
  - `services/torghut/tests/test_decisions.py`
  - `services/torghut/tests/test_scheduler_regime_resolution.py`
  - `services/torghut/tests/test_trading_pipeline.py`
- Planned follow-up validation: `uv sync --frozen --extra dev`, `uv run --frozen pyright --project pyrightconfig.json`,
  `uv run --frozen pyright --project pyrightconfig.alpha.json`, `uv run --frozen pyright --project pyrightconfig.scripts.json`, and targeted Torghut tests.
