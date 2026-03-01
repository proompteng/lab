# Iteration 1 — Regime-adaptive control plane readiness + migration hardening

## Scope
- Reviewed and hardened HMM/routing contracts in forecast + scheduler decision paths.
- Shifted strategy runtime default from `legacy` to `plugin_v3` with explicit runtime fallback controls.
- Added fail-closed behavior for stale/unknown/invalid HMM regime states in execution-critical gate paths.
- Expanded regression coverage across forecasting, decision wiring, scheduler regime resolution, pipeline gates, and config defaults.

## Changes made
- `services/torghut/app/trading/regime_hmm.py`
  - Added `HMMRegimeContext.is_authoritative` to require: non-unknown regime id, non-stale guardrail, non-defensive fallback, and valid `R\d+` regime id pattern.
  - Updated `resolve_regime_route_label` to only trust HMM regime when context is authoritative.
- `services/torghut/app/trading/forecasting.py`
  - Updated router `_resolve_regime` to use `context.is_authoritative`.
- `services/torghut/app/trading/scheduler.py`
  - Updated regime label resolution to only return HMM labels when HMM context is authoritative.
  - Updated runtime regime gate:
    - unknown/non-authoritative regime with no valid fallback label now fails closed (`abstain`) instead of `degrade`.
    - removed legacy fallback path that allowed HMM unknown to pass as `degrade`.
- `services/torghut/app/config.py`
  - Defaulted `TRADING_STRATEGY_RUNTIME_MODE` to `plugin_v3`.
  - Updated description order for clarity.
- Tests updated:
  - `services/torghut/tests/test_forecasting.py`
    - Added stale HMM regime fallback test.
    - Added invalid regime-id fallback-to-explicit-label test.
  - `services/torghut/tests/test_decisions.py`
    - Added stale HMM fallback test for decision params (`route_regime_label`, `regime_label`).
  - `services/torghut/tests/test_scheduler_regime_resolution.py`
    - Added stale HMM fallback-to-legacy assertion.
  - `services/torghut/tests/test_trading_pipeline.py`
    - Added unknown-regime (no label) fail-closed runtime gate regression.
  - `services/torghut/tests/test_config.py`
    - Added default runtime-mode migration assertion (`plugin_v3`, scheduler off, fallback on).

## Validation
- Executed:
  - `python3 -m py_compile app/config.py app/trading/regime_hmm.py app/trading/forecasting.py app/trading/decisions.py app/trading/scheduler.py tests/test_forecasting.py tests/test_decisions.py tests/test_scheduler_regime_resolution.py tests/test_config.py tests/test_trading_pipeline.py`
- Blocked:
  - Python test runner unavailable in environment (`pytest` / `uv` missing, `python3 -m pytest` missing pytest module), so full runtime suite was not executed here.
