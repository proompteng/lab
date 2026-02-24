# LEAN Multi-Lane Control Plane And Rollout Safety

## Scope

This document defines production operations for Torghut LEAN multi-lane capability while preserving Torghut as control plane authority for risk, governance, and rollback safety.

## Implemented Lanes

- `execution`: existing LEAN execution adapter with deterministic Alpaca fallback.
- `research_backtest`: asynchronous LEAN backtest submission/result flow with durable reproducibility metadata.
- `live_shadow_execution`: no-side-effect simulation for live intents, persisted parity telemetry.
- `live_canary_execution`: gated LEAN live routing for configured crypto symbols with hard rollback criteria.
- `strategy_shadow_runtime`: LEAN strategy shadow evaluation path without replacing Torghut decision authority.

## Contract And Safety Foundation

- Torghut enforces submit/read payload contract checks before accepting LEAN responses.
- LEAN runner requires contract-valid request bodies (`extra=forbid`) and records structured audit envelopes.
- Order-routing calls carry:
  - `X-Correlation-ID`
  - `Idempotency-Key`
  - Structured audit payload persisted on execution records (`execution_audit_json`).
- Idempotency replay in LEAN runner returns previous response deterministically and marks replay in `_lean_audit.idempotent_replay`.

## Data Model Additions

Postgres entities:

- `lean_backtest_runs`
- `lean_execution_shadow_events`
- `lean_canary_incidents`
- `lean_strategy_shadow_evaluations`
- `executions.execution_correlation_id`
- `executions.execution_idempotency_key`
- `executions.execution_audit_json`

## Observability

Prometheus metrics:

- `torghut_trading_lean_request_total{operation}`
- `torghut_trading_lean_latency_ms{operation}`
- `torghut_trading_lean_failure_taxonomy_total{operation,taxonomy}`
- `torghut_trading_lean_shadow_parity_total{status}`
- `torghut_trading_lean_shadow_failure_total{taxonomy}`
- `torghut_trading_lean_strategy_shadow_total{status}`
- `torghut_trading_lean_canary_breach_total{breach_type}`

Operational APIs:

- `POST /trading/lean/backtests`
- `GET /trading/lean/backtests/{backtest_id}`
- `GET /trading/lean/shadow/parity`
- LEAN runner observability: `GET /v1/observability`

## Canary And Rollback Gates

Live canary controls:

- `TRADING_LEAN_LIVE_CANARY_ENABLED`
- `TRADING_LEAN_LIVE_CANARY_CRYPTO_ONLY`
- `TRADING_LEAN_LIVE_CANARY_SYMBOLS`
- `TRADING_LEAN_LIVE_CANARY_FALLBACK_RATIO_LIMIT`
- `TRADING_LEAN_LIVE_CANARY_HARD_ROLLBACK_ENABLED`

Explicit disable switch:

- `TRADING_LEAN_LANE_DISABLE_SWITCH=true` disables LEAN lanes and routes to Alpaca path.

Hard rollback criteria:

- Fallback ratio breach (`lean->alpaca`) above configured threshold.
- On breach, Torghut records `lean_canary_incidents` evidence and triggers emergency stop when hard rollback is enabled.

## Kafka/Flink/ClickHouse Operational Verification

GitOps topics added for lane telemetry:

- `torghut.lean.shadow.v1`
- `torghut.lean.backtests.v1`

Data-path verification checklist:

1. Kafka topic presence and tail checks.
2. Flink deployment/job healthy (`RUNNING` state).
3. ClickHouse sink/table freshness checks.
4. Torghut scheduler health via `/trading/status` and `/metrics`.

Use existing helpers:

- `services/torghut/scripts/ta_replay_runner.py`
- `packages/scripts/src/kafka/tail-topic.ts`
- `services/torghut/scripts/validate_market_context_and_lean.sh`
