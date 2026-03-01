# Iteration 2 — Regime safety and transition-aware routing

## Scope

- Strengthen HMM/routing contracts used by forecasting and decision/runtime paths.
- Enforce fail-closed execution handling for non-authoritative HMM regime states.
- Expand tests for transition-shock behavior and migration-safe scheduler enablement.

## Changes made

- `services/torghut/app/trading/regime_hmm.py`
  - Expanded `HMMRegimeContext.is_authoritative` to treat `transition_shock` as non-authoritative for routing/gate decisions.
  - Added `HMMRegimeContext.authority_reason` to provide canonical reasoning for non-authoritative states.

- `services/torghut/app/trading/forecasting.py`
  - Updated `ForecastRouterV5._resolve_regime` to delegate regime routing to `resolve_regime_route_label` so forecast route selection uses a single shared routing contract with guardrails and transition-shock handling.

- `services/torghut/app/trading/scheduler.py`
  - Updated runtime regime gate logic to fail-closed on any non-authoritative regime payload (including invalid/missing regime identifiers), not just when legacy labels are absent.
  - Kept explicit transition-shock and stale/defensive blocks as highest-priority fail-close paths.

- `services/torghut/tests/test_forecasting.py`
  - Added regression: transition-shock HMM context no longer drives HMM-specific route selection.

- `services/torghut/tests/test_decisions.py`
  - Added regression: decision-time route label ignores HMM regime while in transition shock and uses explicit legacy regime input.
  - Added migration regression: scheduler runtime mode does not enable when scheduler flag is off.

- `services/torghut/tests/test_trading_pipeline.py`
  - Added regression: runtime regime gate remains `abstain` when HMM is non-authoritative even if a legacy `regime_label` is present.

## Validation

- Executed: `bun run format`
- Executed: `python3 -m py_compile` on touched Python modules/tests for syntax validation
- Attempted: `python3 -m unittest tests.test_forecasting tests.test_decisions tests.test_trading_pipeline`
  - Blocked by missing Python runtime dependencies in this environment (`pydantic`, `sqlalchemy`).
