# Iteration 2 — Regime safety and transition-aware routing

## Scope

- Strengthen HMM/routing contracts used by forecasting and decision/runtime paths.
- Enforce fail-closed execution handling for non-authoritative HMM regime states.
- Expand tests for transition-shock behavior and migration-safe scheduler enablement.
- Resolve a regression where feature-normalized HMM transition-shock context could be dropped before forecast routing.

## Changes made

- `services/torghut/app/trading/regime_hmm.py`
  - Expanded `HMMRegimeContext.is_authoritative` to treat `transition_shock` as non-authoritative for routing/gate decisions.
  - Added `HMMRegimeContext.authority_reason` to provide canonical reasoning for non-authoritative states.

- `services/torghut/app/trading/forecasting.py`
  - Updated `ForecastRouterV5._resolve_regime` to prefer `route_regime_label` from the normalized feature vector before reparsing HMM context directly, preventing transition-shock drop-through introduced by feature normalization.

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
- Executed: `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- Executed: `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- Executed: `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
- Executed: `cd services/torghut && uv run --frozen python -m unittest tests/test_forecasting.py tests/test_decisions.py tests/test_scheduler_regime_resolution.py`
