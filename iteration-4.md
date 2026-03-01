# Iteration 4 — Router/HMM fallback hardening + scheduler migration tests

## Scope

- Expand router/HMM route-label contract tests across forecast/decision/gate-resolution paths.
- Verify legacy regime payload fallback still works when HMM states are non-authoritative.
- Keep scheduler migration defaults unchanged while validating transition-aware fallback semantics.
- Record verification status and environment blockers for unavailable local Python dependencies.

## Changes

- `services/torghut/tests/test_forecasting.py`
  - Add `test_router_uses_legacy_regime_block_for_fallback_when_hmm_regime_is_invalid` to ensure route matching uses `regime.label` when HMM regime ID is invalid.

- `services/torghut/tests/test_decisions.py`
  - Add `test_decision_regime_route_label_falls_back_to_nested_legacy_regime` to validate runtime decision payloads still derive fallback labels from nested legacy `regime.label`.

- `services/torghut/tests/test_scheduler_regime_resolution.py`
  - Add nested-legacy fallback test coverage for non-authoritative HMM (`test_regime_resolution_prefers_nested_legacy_label_when_hmm_unknown`).
  - Add transition-shock fallback coverage for nested legacy regime labels (`test_regime_resolution_prefers_nested_legacy_label_when_hmm_transition_shock`).

## Verification

- `python3 -m py_compile services/torghut/tests/test_forecasting.py services/torghut/tests/test_decisions.py services/torghut/tests/test_scheduler_regime_resolution.py`
- `cd services/torghut && python3 -m unittest tests.test_forecasting`

## Outcome

- Added regression coverage for legacy fallback safety when HMM state is invalid or in transition.
- No production-path code changes were required; existing runtime contracts already enforce fail-closed handling in scheduler gates.
