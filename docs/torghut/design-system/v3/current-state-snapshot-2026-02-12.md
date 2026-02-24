# Current System Snapshot (2026-02-12)

## Status

- Implementation status: `N/A` (snapshot evidence document; not a direct implementation target)

## Objective

Provide a factual, timestamped snapshot of the Torghut trading system for human review and operational decision-making.

## Snapshot Scope

- Snapshot window (UTC): `2026-02-12T19:07:00Z` to `2026-02-12T19:14:30Z`
- Namespaces: `torghut`, `argocd`, `jangar`
- Planes covered:
  - Control plane (Kubernetes, Argo CD, Knative, Flink, CNPG, ClickHouse operator)
  - Compute plane (running workloads and revisions)
  - Data plane (Postgres + ClickHouse freshness and volume)
  - Decision plane (trading loop state, rejection mix, universe resolution)

## Executive Summary

- Trading pipeline is running end-to-end: WS ingestion, TA/Flink processing, ClickHouse writes, and Torghut decision loop are all active.
- Torghut is currently `live` mode with `TRADING_LIVE_ENABLED=true`, `kill_switch=false`, and `LLM_ENABLED=false`.
- ClickHouse freshness is near-real-time (`lag_seconds <= 3` for both `ta_signals` and `ta_microbars`).
- Recent rejections are dominated by `llm_veto` and `max_position_pct_exceeded`; `symbol_not_allowed` is `0` in the last 10 minutes.
- Argo app `torghut` is `OutOfSync` while `Healthy`, and API server availability was intermittent during capture (`ServiceUnavailable` / `apiserver not ready` observed and recovered).

## Runtime Snapshot

### Control Plane

Sample timestamp: `2026-02-12T19:14:01Z`

| Component              | Probe                                                                  | Observed                                                  |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Knative service        | `kubectl -n torghut get ksvc torghut ...`                              | `latestReadyRevision=torghut-00072`, `Ready=True`         |
| Argo CD app            | `kubectl -n argocd get application torghut ...`                        | `OutOfSync`, `Healthy`, reconciled `2026-02-12T19:09:58Z` |
| FlinkDeployment        | `kubectl -n torghut get flinkdeployment torghut-ta ...`                | `RUNNING`, `STABLE`, `jobManagerDeploymentStatus=READY`   |
| CNPG cluster           | `kubectl -n torghut get clusters.postgresql.cnpg.io torghut-db ...`    | `Cluster in healthy state`, primary `torghut-db-1`        |
| ClickHouseInstallation | `kubectl -n torghut get clickhouseinstallation torghut-clickhouse ...` | `Completed`                                               |

### Workload Health

Sample timestamp: `2026-02-12T19:14:xxZ`

| Workload                                    | Observed                                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `torghut-00072-deployment-56b49c9f94-przzw` | `2/2 Running`, restarts `0/0`                         |
| `torghut-ws-5ddb9bbd9d-8qj4v`               | `1/1 Running`, restarts `7` (last restart ~74m prior) |
| `torghut-ta` JobManager                     | `1/1 Running`                                         |
| `torghut-ta-taskmanager-1-{1..4}`           | all `1/1 Running`                                     |
| `torghut-lean-runner`                       | `1/1 Running`                                         |

## Decision Plane Snapshot

### Trading Status Endpoint

Probe: `GET /trading/status` via in-pod localhost at `2026-02-12T19:14:03Z`

Key fields:

- `enabled=true`
- `mode=live`
- `kill_switch_enabled=false`
- `running=true`
- `last_error=null`
- `llm.enabled=false`
- `metrics.decisions_total=9`
- `metrics.orders_submitted_total=0`
- `metrics.orders_rejected_total=9`
- `metrics.reconcile_updates_total=288`

### Universe State

- Jangar symbols endpoint response:
  - `["ARM","ASML","CRWD","GOOG","LRCX","MSFT","MU","NVDA","SNDK","TSM"]`
- WS config map:
  - `SYMBOLS=CRWD,MU,NVDA` (fallback),
  - `JANGAR_SYMBOLS_URL=http://jangar.jangar.svc.cluster.local/api/torghut/symbols`,
  - `SYMBOLS_POLL_INTERVAL_MS=30000`
- Strategies in Postgres (`strategies`):
  - Enabled strategy: `intraday-tsmom-profit-v2`, `universe_symbols=null` (global universe driven),
  - Disabled: `intraday-tsmom-v1`, `macd-rsi-default`.

## Data Plane Snapshot

### Postgres (`torghut-db`)

Sample timestamp: `2026-02-12T19:14:01Z`

Row counts:

- `strategies=3`
- `trade_decisions=3887`
- `executions=567`
- `llm_decision_reviews=11015`
- `position_snapshots=4535`

Recent 10-minute decision statuses:

- `rejected=33`
- `planned=1`

Recent 10-minute rejection reasons:

- `["llm_veto"] = 21`
- `["max_position_pct_exceeded"] = 10`
- `["qty_below_min"] = 2`

Symbol allowlist check:

- `symbol_not_allowed` in last 10 minutes: `0`

Latest account snapshot (`position_snapshots`):

- `as_of=2026-02-12 19:13:51.050276+00`
- `equity=30100.21000000`
- `cash=12521.56000000`
- `buying_power=92595.00000000`
- `positions_count=8`
- `alpaca_account_label=live`

### ClickHouse (`torghut`)

Sample timestamp: `2026-02-12T19:14:04Z`

Table volume + freshness:

- `ta_signals`: `239343` rows, `max_event_ts=2026-02-12 19:14:04.000`, lag `3s`
- `ta_microbars`: `224879` rows, `max_event_ts=2026-02-12 19:14:06.000`, lag `1s`

Top symbols in `ta_signals` over last 10 minutes:

- `MSFT=283`
- `NVDA=251`
- `MU=123`
- `TSM=108`
- `GOOG=102`
- `SNDK=74`
- `LRCX=68`
- `ARM=38`
- `CRWD=27`
- `ASML=26`

Replica state (`system.replicas`):

- `ta_microbars`: `is_readonly=0`, `is_session_expired=0`, `queue_size=1`, `inserts_in_queue=1`
- `ta_signals`: `is_readonly=0`, `is_session_expired=0`, `queue_size=0`, `inserts_in_queue=0`

## Operational Findings

1. System is actively processing market data and running the trading loop.
2. Rejection mix indicates policy/risk and LLM-gate behavior, not data starvation.
3. Symbol universe mismatch issue is not present in current 10-minute window.
4. Argo drift remains unresolved (`OutOfSync`) and should be reconciled via PR + sync.
5. Kubernetes API server intermittency occurred during this capture window and should be treated as platform reliability risk.

## Evidence Commands

Primary command set used:

- `kubectl -n torghut get ksvc torghut ...`
- `kubectl -n argocd get application torghut ...`
- `kubectl -n torghut get flinkdeployment torghut-ta ...`
- `kubectl -n torghut exec torghut-db-1 -- psql ...`
- `kubectl -n torghut exec chi-torghut-clickhouse-default-0-0-0 -- clickhouse-client ...`
- `kubectl -n torghut exec <torghut-pod> -c user-container -- python -c "<HTTP probe>"`
