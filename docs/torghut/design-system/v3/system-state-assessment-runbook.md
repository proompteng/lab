# Torghut System State Assessment Runbook

## Objective
Assess whether Torghut is healthy enough to trade, identify the failing layer when unhealthy, and provide a repeatable triage flow.

## Scope
- Namespace focus: `torghut`
- Dependencies checked: `argocd`, `jangar`
- Data stores: CNPG Postgres + ClickHouse
- Pipeline: WS -> Kafka -> Flink TA -> ClickHouse -> Torghut decision loop -> executions

## Preconditions
- `kubectl` context points to production cluster.
- Operator has read access to `torghut`, `argocd`, and `jangar` namespaces.
- `kubectl cnpg` plugin available for CNPG SQL convenience (optional).

## Severity Model
- `GREEN`: trading safe to continue (no critical failures, data fresh, controls intact).
- `YELLOW`: degraded but controlled (data flow present, but drift/rejections/latency issues).
- `RED`: immediate intervention required (data stale, component down, or safety gate broken).

## Step 0: Fast Connectivity Check (1 minute)
```bash
kubectl cluster-info
kubectl -n torghut get pods
```
Interpretation:
- If API server is unstable (`ServiceUnavailable`, `apiserver not ready`), classify platform as at least `YELLOW`.
- If repeated failures persist > 3 minutes, escalate platform incident and classify `RED`.

## Step 1: Control Plane Health (2 minutes)
```bash
kubectl -n argocd get application torghut -o jsonpath='{.status.sync.status} {.status.health.status} {.status.reconciledAt}'; echo
kubectl -n torghut get ksvc torghut -o jsonpath='{.status.latestReadyRevisionName} {.status.conditions[?(@.type=="Ready")].status}'; echo
kubectl -n torghut get flinkdeployment torghut-ta -o jsonpath='{.status.jobStatus.state} {.status.lifecycleState} {.status.jobManagerDeploymentStatus}'; echo
kubectl -n torghut get clusters.postgresql.cnpg.io torghut-db -o wide
kubectl -n torghut get clickhouseinstallation torghut-clickhouse -o wide
```
Pass criteria:
- ksvc Ready = `True`
- Flink = `RUNNING STABLE READY`
- CNPG = healthy state
- ClickHouseInstallation = `Completed`

## Step 2: Workload Health (2 minutes)
```bash
kubectl -n torghut get pods -o wide
kubectl -n torghut get deploy torghut-ws torghut-ta torghut-lean-runner -o wide
kubectl -n torghut get pods -l app=torghut-ta,component=taskmanager
```
Pass criteria:
- Torghut pod has all containers ready.
- `torghut-ws`, `torghut-ta`, and `torghut-lean-runner` each have available replicas.
- 4/4 TA taskmanagers ready.

## Step 3: Trading Loop Runtime State (2 minutes)
```bash
TORGHUT_POD=$(kubectl -n torghut get pods -l serving.knative.dev/service=torghut -o jsonpath='{.items[0].metadata.name}')
kubectl -n torghut exec "$TORGHUT_POD" -c user-container -- python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:8181/trading/status',timeout=10).read().decode())"
kubectl -n torghut exec "$TORGHUT_POD" -c user-container -- python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:8181/trading/metrics',timeout=10).read().decode())"
```
Pass criteria:
- `running=true`
- `last_error=null`
- `kill_switch_enabled=false` (unless intentionally enabled)
- Metrics counters moving over time (decisions/reconcile at minimum)

## Step 4: Universe Consistency Check (2 minutes)
```bash
kubectl -n torghut exec "$TORGHUT_POD" -c user-container -- python -c "import urllib.request;print(urllib.request.urlopen('http://jangar.jangar.svc.cluster.local/api/torghut/symbols',timeout=10).read().decode())"
kubectl -n torghut get configmap torghut-ws-config -o jsonpath='{.data.SYMBOLS} {.data.JANGAR_SYMBOLS_URL} {.data.SYMBOLS_POLL_INTERVAL_MS}'; echo
kubectl -n torghut exec torghut-db-1 -- psql -U postgres -d torghut -P pager=off -c "select name,enabled,coalesce(universe_symbols::text,'null') as universe_symbols from strategies order by enabled desc,name;"
```
Pass criteria:
- Jangar symbols endpoint returns non-empty list.
- Enabled strategy does not unintentionally restrict symbols.
- If recent `symbol_not_allowed` spikes occur, classify `YELLOW` and inspect strategy `universe_symbols` immediately.

## Step 5: Postgres Decision/Execution Health (4 minutes)
```bash
kubectl -n torghut exec torghut-db-1 -- psql -U postgres -d torghut -P pager=off -c "select 'strategies' as table, count(*) as rows from strategies union all select 'trade_decisions', count(*) from trade_decisions union all select 'executions', count(*) from executions union all select 'llm_decision_reviews', count(*) from llm_decision_reviews union all select 'position_snapshots', count(*) from position_snapshots;"
kubectl -n torghut exec torghut-db-1 -- psql -U postgres -d torghut -P pager=off -c "select status,count(*) from trade_decisions where created_at >= now()-interval '10 minutes' group by status order by count(*) desc;"
kubectl -n torghut exec torghut-db-1 -- psql -U postgres -d torghut -P pager=off -c "select decision_json->>'risk_reasons' as reason,count(*) from trade_decisions where created_at >= now()-interval '10 minutes' and status='rejected' group by 1 order by 2 desc;"
kubectl -n torghut exec torghut-db-1 -- psql -U postgres -d torghut -Atc "select count(*) from trade_decisions where created_at >= now()-interval '10 minutes' and status='rejected' and decision_json->>'risk_reasons' like '%symbol_not_allowed%';"
kubectl -n torghut exec torghut-db-1 -- psql -U postgres -d torghut -P pager=off -c "select as_of,equity,cash,buying_power,jsonb_array_length(positions) as positions_count,alpaca_account_label from position_snapshots order by as_of desc limit 3;"
```
Interpretation:
- High rejection ratio is acceptable only if reasons are expected policy gates.
- `symbol_not_allowed > 0` after a universe rollout is a direct misconfiguration signal.
- Missing fresh position snapshots is `RED` for execution confidence.

## Step 6: ClickHouse Freshness and Replica Health (4 minutes)
```bash
CH_PASS=$(kubectl -n torghut get secret torghut-clickhouse-auth -o jsonpath='{.data.torghut_password}' | base64 --decode)
kubectl -n torghut exec chi-torghut-clickhouse-default-0-0-0 -- clickhouse-client --user torghut --password "$CH_PASS" -q "SELECT 'ta_signals' AS table, count() AS rows, max(event_ts) AS max_event_ts, dateDiff('second', max(event_ts), now()) AS lag_seconds FROM torghut.ta_signals UNION ALL SELECT 'ta_microbars', count(), max(event_ts), dateDiff('second', max(event_ts), now()) FROM torghut.ta_microbars;"
kubectl -n torghut exec chi-torghut-clickhouse-default-0-0-0 -- clickhouse-client --user torghut --password "$CH_PASS" -q "SELECT symbol, count() AS rows FROM torghut.ta_signals WHERE event_ts >= now() - INTERVAL 10 MINUTE GROUP BY symbol ORDER BY rows DESC LIMIT 10;"
kubectl -n torghut exec chi-torghut-clickhouse-default-0-0-0 -- clickhouse-client --user torghut --password "$CH_PASS" -q "SELECT database, table, is_readonly, is_session_expired, queue_size, inserts_in_queue FROM system.replicas WHERE database='torghut' ORDER BY table;"
```
Pass criteria:
- `lag_seconds` near-real-time (typically single-digit seconds during market hours).
- Replica flags remain `is_readonly=0`, `is_session_expired=0`.

## Classification Rules
- `GREEN`:
  - All critical components healthy,
  - ClickHouse fresh,
  - Decision loop running with expected rejection profile.
- `YELLOW`:
  - Argo OutOfSync,
  - elevated rejection concentration (policy/LLM),
  - intermittent control plane/API instability.
- `RED`:
  - ksvc not ready,
  - Flink not running,
  - stale ClickHouse data,
  - Postgres unavailable,
  - unexpected safety bypass or kill-switch inconsistency.

## Immediate Actions by Failure Mode
- `symbol_not_allowed` spike:
  - compare strategy `universe_symbols` vs Jangar symbols endpoint,
  - remove unintended strategy-level symbol cap,
  - verify 10-minute rejection mix.
- Flink degraded:
  - inspect `kubectl -n torghut logs deploy/torghut-ta --since=15m`,
  - verify checkpoints advancing.
- ClickHouse replica issues:
  - inspect `system.replicas`,
  - follow `docs/torghut/design-system/v1/operations-clickhouse-replica-and-keeper.md`.
- WS ingestion issues:
  - inspect `kubectl -n torghut logs deploy/torghut-ws --since=15m`,
  - verify Kafka produce responses continue.

## Human Review Output Template
Use this format in incident/report updates:
- Snapshot time (UTC):
- Overall status (`GREEN`/`YELLOW`/`RED`):
- ksvc/flink/cnpg/clickhouse states:
- Data freshness (`ta_signals` lag / `ta_microbars` lag):
- 10-minute decision status mix:
- Top rejection reasons:
- Symbol mismatch check result:
- Required actions and owner:

