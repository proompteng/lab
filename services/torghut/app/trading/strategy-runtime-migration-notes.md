# Strategy Runtime Migration Notes (Scheduler V3)

## Overview
This migration introduces deterministic scheduler-integrated strategy execution with three layers:

- `StrategyRegistry`: resolves strategy plugins by `strategy_type` + `version`, and tracks circuit/degraded state.
- `StrategyRuntime`: evaluates all enabled strategies with per-plugin isolation.
- `IntentAggregator`: resolves conflicting intents deterministically at symbol+horizon scope.

## Runtime Flags
Use these environment variables to control rollout:

- `TRADING_STRATEGY_RUNTIME_MODE=legacy|plugin_v3|scheduler_v3`
- `TRADING_STRATEGY_SCHEDULER_ENABLED=true|false`
- `TRADING_STRATEGY_RUNTIME_FALLBACK_LEGACY=true|false`
- `TRADING_STRATEGY_RUNTIME_CIRCUIT_ERRORS=<int>`
- `TRADING_STRATEGY_RUNTIME_CIRCUIT_COOLDOWN_SECONDS=<int>`

Recommended staged rollout:

1. Set `TRADING_STRATEGY_RUNTIME_MODE=scheduler_v3`
2. Keep `TRADING_STRATEGY_SCHEDULER_ENABLED=false` to verify configuration without behavioral change.
3. Enable `TRADING_STRATEGY_SCHEDULER_ENABLED=true` with `TRADING_STRATEGY_RUNTIME_FALLBACK_LEGACY=true`.
4. Monitor runtime metrics (`strategy_*`, `intent_conflict_total`, fallback counters).
5. Only consider `TRADING_STRATEGY_RUNTIME_FALLBACK_LEGACY=false` after stable soak.

## Safety Semantics
Risk and kill-switch behavior is unchanged:

- `TRADING_KILL_SWITCH_ENABLED` is still enforced before order submission.
- Runtime failures are isolated per plugin; scheduler cycle continues and commits ingest cursor.
- Legacy fallback is available to avoid decision stalls during migration.

## Deterministic Replay
Replay determinism is validated in `services/torghut/tests/test_strategy_runtime.py`.
Use fixed signal fixtures and strategy parameters to verify identical aggregated intents across runs.
