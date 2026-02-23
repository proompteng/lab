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

## Multi-Account Execution Rollout (Default OFF)
The multi-account isolation path is gated behind `TRADING_MULTI_ACCOUNT_ENABLED` and the feature flag key
`torghut_trading_multi_account_enabled`.

- Default posture: `TRADING_MULTI_ACCOUNT_ENABLED=false` and Flipt flag disabled.
- OFF mode behavior: runtime remains single-account and uses `TRADING_ACCOUNT_LABEL` as before.
- ON mode behavior: scheduler supervises one execution lane per enabled account in `TRADING_ACCOUNTS_JSON`.

### Migration Safety
- Schema migration `0013_multi_account_execution_isolation` is additive:
  - adds `executions.alpaca_account_label`,
  - adds account-scoped unique indexes for decisions/executions,
  - adds `trade_cursor.account_label`,
  - adds `execution_order_events.alpaca_account_label`.
- Existing single-account rows are backfilled to `paper` (or linked decision account label where available).
- `trade-updates.v2` is dual-read compatible: Torghut still accepts v1 and falls back to `TRADING_ACCOUNT_LABEL`.

### Rollback Plan
1. Disable Flipt flag `torghut_trading_multi_account_enabled`.
2. Set `TRADING_MULTI_ACCOUNT_ENABLED=false`.
3. Leave additive schema in place; do not drop account-scoped columns/indexes during incident rollback.
4. Keep `TRADING_ORDER_FEED_TOPIC` on v1 and clear `TRADING_ORDER_FEED_TOPIC_V2` if needed.

### Canary Steps (Enable Second Account)
1. Keep `TRADING_MULTI_ACCOUNT_ENABLED=false` while deploying schema + code.
2. Add second account to `TRADING_ACCOUNTS_JSON` but keep flag OFF.
3. Enable Flipt `torghut_trading_multi_account_enabled` for canary entity.
4. Enable `TRADING_MULTI_ACCOUNT_ENABLED=true` and set WS `TORGHUT_ACCOUNT_LABEL` + `TOPIC_TRADE_UPDATES_V2`.
5. Verify per-account rows in `trade_decisions`, `executions`, and `trade_cursor` and ensure no cross-account reconciliation.
