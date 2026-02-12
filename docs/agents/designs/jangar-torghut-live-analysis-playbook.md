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
```

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
```

### 8. Exporter metrics checks
```bash
kubectl -n torghut port-forward svc/torghut-llm-guardrails-exporter 19110:9110
curl -fsS http://127.0.0.1:19110/metrics | rg '^torghut_llm_'

kubectl -n torghut port-forward svc/torghut-clickhouse-guardrails-exporter 19108:9108
curl -fsS http://127.0.0.1:19108/metrics | rg '^torghut_clickhouse_guardrails_'

kubectl -n agents port-forward svc/agents-metrics 19090:9090
curl -i http://127.0.0.1:19090/metrics
```

### 9. Source-code anchor pass (minimum)
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

## Evidence Output Template
Use this in every design/incident note:
- Timestamp window (UTC).
- Kube context.
- Namespace/deployment readiness summary.
- Torghut runtime posture (`paper/live`, kill-switch, LLM counters).
- CNPG snapshots (torghut + jangar key table counts + latest timestamps).
- ClickHouse freshness + 24h volumes.
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

