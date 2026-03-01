# Iteration 4 — Regime router/HMM fail-closed + migration hardening

## Scope

- Strengthen regime-HMM routing contracts consumed by runtime decisions and execution gates.
- Keep scheduler/runtime migration defaults moving toward scheduler/plugin path while preserving conservative fallback behavior.
- Add explicit fail-closed behavior coverage for stale/transition/invalid regime states in execution-critical paths.
- Expand regression tests around route-label fallback safety and transition state handling.

## Changes

- `services/torghut/app/trading/regime_hmm.py`
  - Added `route_regime_label` as an explicit hint in `resolve_regime_route_label`.
  - Added `resolve_regime_context_authority_reason()` to normalize contract-facing reasons for non-authoritative HMM contexts.
  - Exported the new helper and preserved canonical authoritative/non-authoritative behavior.

- `services/torghut/app/trading/decisions.py`
  - Updated regime context resolution to keep route-label preference centralized through `resolve_regime_route_label`, including explicit `route_regime_label` hints.

- `services/torghut/app/trading/scheduler.py`
  - Threaded non-authoritative HMM reason contracts through `_resolve_decision_regime_label_with_source()`.
  - Preserved fail-closed routing intent for execution gates and now carries regime IDs through fail-closed gate paths for observability.

- `services/torghut/app/config.py`
  - Clarified strategy-runtime mode description to reflect plugin/scheduler migration behavior and controls.

- Tests
  - `services/torghut/tests/test_forecasting.py`
    - Added router fallback test for explicit `route_regime_label` precedence when HMM regime state is invalid.
  - `services/torghut/tests/test_decisions.py`
    - Added decision-context test verifying explicit `route_regime_label` is preserved on invalid HMM payloads.
  - `services/torghut/tests/test_scheduler_regime_resolution.py`
    - Updated transition-shock fallback assertions to assert transition-specific fallback reason in legacy fallback path.
  - `services/torghut/tests/test_trading_pipeline.py`
    - Added invalid-regime-id fail-closed gate coverage.

## Verification plan

- Run targeted regime/decision/scheduler/pipeline unit tests under `services/torghut`.
- Run required Torghut Python checks (`pyright` profiles and unit tests) before PR creation.
