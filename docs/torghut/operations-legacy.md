# Torghut Runbooks (Rotations, Incidents, Upgrades)

> Note: Canonical production-facing runbooks live in `docs/torghut/design-system/v1/operations-ta-replay-and-recovery.md`
> and related `docs/torghut/design-system/v1/operations-*.md`. This file is supporting material and may drift
> from the current deployed manifests.

## Alpaca credential rotation
1) Update sealed-secret manifest with new `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` in torghut namespace.
2) Apply SealedSecret via Argo CD sync (or `kubectl apply` in emergency, then reconcile Argo).
3) Restart kotlin-ws Deployment to pick up keys.
4) Verify ws readiness and status topic emits `healthy`; check logs for 401/403.

## KafkaUser (SCRAM) rotation
1) In Strimzi, rotate password on the KafkaUser for torghut (or create new user and update references).
2) Allow Strimzi to update the Secret; if using reflector, ensure it copies into torghut namespace.
3) Restart kotlin-ws and Flink workloads to pick up new password/truststore.
4) Confirm produce/consume success; watch for SASL auth errors.

## MinIO checkpoint credential rotation
1) Create new MinIO user/key scoped to checkpoint bucket.
2) Update Secret in torghut with `fs.s3a.access.key` / `fs.s3a.secret.key`.
3) Trigger a Flink savepoint (optional) and restart FlinkDeployment so the new creds are used.
4) Verify checkpoints succeed; delete old user/key after validation.

## Flink upgrade / rollback
Upgrade (safe):
- Trigger savepoint (or use last-state) via FlinkDeployment spec.
- Bump job image tag in kustomization; Argo sync.
- Verify checkpoints continue and sinks emit.

Rollback:
- Revert image tag to previous version; set `state: last-state` or point to last savepoint.
- Sync Argo; verify job runs and outputs resume.

## Alpaca WS incident (406 connection limit)
- Ensure only one kotlin-ws replica is running; scale down accidental extra pods.
- Force close lingering connections by restarting the Deployment.
- Confirm status topic transitions to `healthy` and logs show successful subscribe.

## Trading loop (paper mode)
Prerequisites:
- ClickHouse access: ensure `torghut-clickhouse-auth` secret is present and valid.
- Database schema: `trade_decisions`, `executions`, and cursor tables must exist; run migrations via the torghut deploy script
  before enabling trading in a new environment (do not run live migrations without explicit approval).
- Alpaca keys: optional for startup, but required to submit paper or live orders; set `APCA_API_KEY_ID` and
  `APCA_API_SECRET_KEY` in `torghut-alpaca` when executing orders.

Enable trading loop:
1) Confirm `argocd/applications/torghut/knative-service.yaml` has `TRADING_ENABLED=true`,
   `TRADING_MODE=paper`, and `TRADING_LIVE_ENABLED=false`.
2) Ensure `JANGAR_SYMBOLS_URL` is reachable (or switch to `TRADING_UNIVERSE_SOURCE=static` + `TRADING_STATIC_SYMBOLS`).
3) Define strategies in `argocd/applications/torghut/strategy-configmap.yaml` and ensure
   `TRADING_STRATEGY_CONFIG_PATH` is set (hot-reload applies changes). For ad-hoc dev/stage seeding:
   `uv run python services/torghut/scripts/seed_strategy.py --name macd-rsi-default --base-timeframe 1Min --symbols AAPL,MSFT --enabled`
4) Sync the Argo CD application for torghut.
5) Verify `kubectl -n torghut get ksvc torghut` is Ready and `GET /trading/status` returns enabled `true`.

Disable trading loop:
1) Set `TRADING_ENABLED=false` (and optionally set `minScale: "0"` if you want the service to idle).
2) Sync the Argo CD application for torghut.
3) Verify `/trading/status` reports enabled `false` and no new decisions are written.

Trading audit + metrics:
- `GET /trading/decisions?symbol=&since=` returns recent decision rows.
- `GET /trading/executions?symbol=&since=` returns recent executions.
- `GET /trading/metrics` returns counters for decisions, orders, and LLM outcomes.
- `GET /trading/status` includes LLM circuit breaker state (`llm.circuit.open`) and shadow mode flags.

LLM review operations:
- **Shadow mode**: set `LLM_ENABLED=true`, `LLM_SHADOW_MODE=true`. Reviews are stored but do not veto/adjust orders.
- **Circuit breaker open**: `llm.circuit.open=true` in `/trading/status` means LLM calls are skipped until cooldown.
  Inspect `llm.circuit.recent_error_count`, fix upstream API issues, then wait for cooldown to clear or restart
  the torghut service to reset the breaker window (paper only).

## Kafka produce failures
- Readiness should go false; inspect auth/ACL, broker reachability, and SASL secrets.
- After fixes, rolling restart the kotlin-ws service; confirm status messages return to healthy.

## Lag spike (WS → TA)
- Check kotlin-ws metric `ws_lag_ms` and Flink watermark lag.
- Reconnect WS if kotlin-ws lagged; tune watermark/idle-timeout if Flink is blocking on idle partitions.
- If Kafka is slow, check broker health and consumer lag.

## Torghut TA visuals validation
1) Ensure `VITE_TORGHUT_VISUALS_ENABLED=true` in Jangar and reload `/torghut/visuals`.
2) Pick a known symbol with TA data and confirm candlesticks render from `/api/torghut/ta/bars`.
3) Toggle indicators (EMA/Bollinger/VWAP/MACD/RSI) and confirm `/api/torghut/ta/signals` populates overlays.
4) Verify lag pill updates from `/api/torghut/ta/latest` and stays under the target threshold.
5) Force an empty state (symbol with no data) and confirm the UI shows the no-data message.
6) Induce a failure (block API or bad symbol) and confirm the error banner is visible.
