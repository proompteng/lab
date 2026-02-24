# Jangar/Torghut Live Analysis Playbook (Fast Path)

Status: Proposed (2026-02-12)

Docs index: [README](../README.md)

## Objective

Provide a repeatable method to analyze Jangar + Torghut system state in under 15 minutes with hard evidence from:

- Kubernetes runtime,
- CNPG Postgres,
- ClickHouse,
- live service endpoints,
- source code paths.

This document is optimized for design validation, incident triage, and rollout readiness checks.

## Scope

- Fast operational assessment for trading/control-plane readiness.
- Evidence collection commands and expected artifacts.
- Known failure signatures and first fixes.

Non-goals:

- Full incident response runbook.
- Deep strategy research analysis.

## Preconditions

- Correct kube context selected.
- `kubectl` access to namespaces: `agents`, `jangar`, `torghut`.
- `kubectl cnpg` plugin installed.
- Read access to secrets required for ClickHouse auth.
- `rg`, `jq`, `curl` available locally.

## 15-Minute Analysis Sequence

### 1. Establish context and timestamp

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ"
kubectl config current-context
kubectl get ns | awk 'NR==1 || $1=="agents" || $1=="jangar" || $1=="torghut" {print}'
```

### 2. Runtime health snapshot

```bash
kubectl -n agents get deploy,pods,svc
kubectl -n jangar get deploy,pods,svc
kubectl -n torghut get ksvc,deploy,pods,svc
```

### 3. Control-plane health truth

```bash
kubectl -n jangar port-forward svc/jangar 18080:80
curl -fsS "http://127.0.0.1:18080/api/agents/control-plane/status?namespace=agents" | jq .
```

### 4. Torghut runtime posture (authoritative)

Use pod private port when service route/pathing is uncertain.

```bash
kubectl -n torghut port-forward pod/<torghut-ready-pod> 18081:8012
curl -fsS http://127.0.0.1:18081/trading/status | jq .
curl -fsS http://127.0.0.1:18081/trading/health | jq .
curl -fsS http://127.0.0.1:18081/trading/status | jq '{
  rollback,
  control_plane_contract: .control_plane_contract,
  autonomy: {
    last_ingest_reason,
    last_ingest_window_start,
    last_ingest_window_end
  },
  metrics: {
    signal_lag_seconds: .metrics.signal_lag_seconds,
    no_signal_reason_streak: .metrics.no_signal_reason_streak,
    signal_staleness_alert_total: .metrics.signal_staleness_alert_total
  }
}'
```

Interpretation shortcut:

- If `signal_lag_seconds` is high while US market is closed, treat as expected unless freshness alerts fire during open session.
- If `rollback.emergency_stop_active=true`, always inspect `rollback.emergency_stop_reason` before attributing rejects to current feed state.

### 5. CNPG data checks (Torghut)

```bash
kubectl cnpg status -n torghut torghut-db
kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "select count(*) from strategies;"
kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "select status, count(*) from trade_decisions group by status order by count(*) desc;"
kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "select count(*), max(created_at) from executions;"
kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "select count(*), max(as_of) from position_snapshots;"
```

### 6. CNPG data checks (Jangar)

```bash
kubectl cnpg status -n jangar jangar-db
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c "select count(*) from information_schema.tables where table_schema='public';"
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c "select status, count(*) from agent_runs group by status order by count(*) desc;"
```

### 7. ClickHouse feed and freshness checks

Do not use default user; use `torghut` credentials from secret.

```bash
CH_PASS=$(kubectl -n torghut get secret torghut-clickhouse-auth -o jsonpath='{.data.torghut_password}' | base64 --decode)

kubectl -n torghut exec chi-torghut-clickhouse-default-0-0-0 -- \
  clickhouse-client --user torghut --password "$CH_PASS" \
  --query "select now(), max(event_ts), dateDiff('second', max(event_ts), now()), countIf(event_ts >= now() - interval 24 hour) from torghut.ta_signals;"

kubectl -n torghut exec chi-torghut-clickhouse-default-0-0-0 -- \
  clickhouse-client --user torghut --password "$CH_PASS" \
  --query "select now(), max(window_end), dateDiff('second', max(window_end), now()), countIf(window_end >= now() - interval 24 hour) from torghut.ta_microbars;"

# Keep diagnostics bounded by UTC window; avoid broad GROUP BY on entire table.
kubectl -n torghut exec chi-torghut-clickhouse-default-0-0-0 -- \
  clickhouse-client --user torghut --password "$CH_PASS" \
  --query "SELECT min(event_ts), max(event_ts), count() FROM torghut.ta_signals WHERE event_ts >= toDateTime64('<start-utc>',3,'UTC') AND event_ts < toDateTime64('<end-utc>',3,'UTC') FORMAT Vertical"
```

### 8. Lag Root-Cause Differential (Postgres + ClickHouse + Revision Config)

Use this sequence when you see `signal_lag_exceeded:*` rejects.

```bash
# 1) Confirm reject reason shape and whether lag value is static/latching.
kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "
WITH reasons AS (
  SELECT td.created_at, r.reason
  FROM trade_decisions td
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(td.decision_json::jsonb->'risk_reasons','[]'::jsonb)) r(reason)
  WHERE (td.created_at AT TIME ZONE 'America/New_York')::date = DATE '<trading-day-et>'
    AND td.status='rejected'
)
SELECT reason, count(*) FROM reasons GROUP BY reason ORDER BY count(*) DESC;"

# 2) Check whether fresh ta_signals existed during reject timestamps.
kubectl -n torghut exec chi-torghut-clickhouse-default-0-0-0 -- \
  clickhouse-client --user torghut --password "$CH_PASS" \
  --query "SELECT event_ts, ingest_ts, symbol, seq FROM torghut.ta_signals WHERE event_ts >= toDateTime64('<reject-window-start-utc>',3,'UTC') AND event_ts <= toDateTime64('<reject-window-end-utc>',3,'UTC') ORDER BY event_ts, symbol, seq LIMIT 50"

# 3) Verify rollout/revision config drift for emergency stop toggles.
kubectl -n torghut get revision | awk 'NR==1 || /torghut-0000/'
kubectl -n torghut get revision <old-revision> -o yaml | rg -n "TRADING_EMERGENCY_STOP_ENABLED|TRADING_ROLLBACK_SIGNAL_LAG_SECONDS_LIMIT"
kubectl -n torghut get revision <new-revision> -o yaml | rg -n "TRADING_EMERGENCY_STOP_ENABLED|TRADING_ROLLBACK_SIGNAL_LAG_SECONDS_LIMIT"
```

### 9. Exporter metrics checks

```bash
kubectl -n torghut port-forward svc/torghut-llm-guardrails-exporter 19110:9110
curl -fsS http://127.0.0.1:19110/metrics | rg '^torghut_llm_'

kubectl -n torghut port-forward svc/torghut-clickhouse-guardrails-exporter 19108:9108
curl -fsS http://127.0.0.1:19108/metrics | rg '^torghut_clickhouse_guardrails_'

kubectl -n agents port-forward svc/agents-metrics 19090:9090
curl -i http://127.0.0.1:19090/metrics
```

### 10. Source-code anchor pass (minimum)

```bash
rg -n "TradingScheduler|ExecutionPolicy|OrderExecutor|/trading/status" services/torghut/app
rg -n "torghut-trading|control-plane/status|control-plane/stream|metrics" services/jangar/src
```

## Known Failure Signatures and First Actions

### `self signed certificate in certificate chain` from `/api/torghut/trading/*`

Symptoms:

- Jangar trading summary/strategies endpoints return 500.
  Likely cause:
- `TORGHUT_DB_DSN` TLS trust chain mismatch.
  First actions:

1. Confirm `TORGHUT_DB_DSN` secret includes `sslmode`/CA trust path as needed.
2. Ensure Jangar container trusts Torghut DB CA or DSN points to proper SSL settings.
3. Re-test `/api/torghut/trading/strategies` and `/api/torghut/trading/summary?day=...`.

### ClickHouse auth failures with `default` user

Symptoms:

- `clickhouse-client` auth failed for `default`.
  First action:
- Use `torghut` user + `torghut-clickhouse-auth` secret password.

### `agents-metrics` returns `404`

Symptoms:

- Service reachable but `/metrics` is not exposed.
  First actions:

1. Verify Jangar Prometheus exporter path (`JANGAR_PROMETHEUS_METRICS_PATH`).
2. Confirm server route interception is wired (`services/jangar/server.ts`).
3. Validate ServiceMonitor config and target path alignment.

### Kubernetes API transient refusal

Symptoms:

- `connect: connection refused` to kube API.
  First actions:

1. Re-check VPN/network and context endpoint.
2. Retry once network stabilizes.
3. Mark evidence cut-off time in report.

### Constant `signal_lag_exceeded:<N>` rejects while fresh `ta_signals` exist

Symptoms:

- Large block of rejects with identical lag value (for example `signal_lag_exceeded:28019`).
- ClickHouse shows `event_ts` and `ingest_ts` flowing during reject window.
  Likely cause:
- Emergency stop latched on a previous freshness breach and stayed active.
  First actions:

1. Inspect `/trading/status.rollback` fields (`emergency_stop_active`, reason, trigger/resolution timestamps, recovery streak).
2. Compare Knative revisions and env (`TRADING_EMERGENCY_STOP_ENABLED`, lag threshold) around incident time.
3. Verify whether rejects stop immediately after revision/config change.
4. If freshness has recovered and only recoverable reasons remain, validate auto-clear hysteresis behavior in scheduler safety logs.

## Evidence Output Template

Use this in every design/incident note:

- Timestamp window (UTC).
- Kube context.
- Namespace/deployment readiness summary.
- Torghut runtime posture (`paper/live`, kill-switch, LLM counters).
- CNPG snapshots (torghut + jangar key table counts + latest timestamps).
- ClickHouse freshness + 24h volumes.
- Knative revision + emergency-stop env diff when behavior changes intra-day.
- Reject reason distribution with UTC window boundaries.
- API errors observed (exact message).
- Code paths verified.
- Unknowns/blocked checks.

## Design Doc Update Rules (After Analysis)

After each live analysis pass, update affected design docs with:

1. Exact timestamped facts.
2. Verified constraints/blockers.
3. Any required phase-0 hardening work.
4. Command set used for verification.

Minimum docs to refresh in this lane:

- `docs/agents/designs/jangar-trading-control-plan.md`
- `docs/agents/designs/jangar-quant-performance-control-plane.md`
- `docs/torghut/design-system/v3/jangar-market-intelligence-and-lean-integration-plan.md`
- `docs/torghut/design-system/v3/jangar-bespoke-decision-endpoint-and-intraday-loop-design.md`
