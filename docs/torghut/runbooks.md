# Torghut Runbooks (Rotations, Incidents, Upgrades)

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
