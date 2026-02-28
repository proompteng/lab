# Historical Simulation Playbook

Last updated: **2026-02-28**

This playbook is the production run procedure for Torghut historical simulations using
`services/torghut/scripts/start_historical_simulation.py`.

It is designed for runs that must preserve production safety while producing empirical evidence.

## Scope

Use this playbook when you need to:

- replay bounded historical topic windows into simulation topics,
- run TA + Torghut with simulation storage/topic isolation,
- collect measured outcomes from signals through execution metadata,
- restore production runtime settings after the run.

## Safety Guardrails

- Never run `apply` without a unique `run_id`.
- Never run simulation with production Postgres/ClickHouse targets.
- Keep Torghut in paper mode during simulation (`TRADING_MODE=paper`, `TRADING_LIVE_ENABLED=false`).
- Run `teardown` in the same `run_id` immediately after evidence collection.
- Keep `argocd.manage_automation=true` in manifest so automation is switched/restored by the script.

## Prerequisites

- `kubectl` access to the target cluster and namespace (`torghut`).
- Python runtime + dependencies for the script (`uv sync --frozen --extra dev` in `services/torghut`).
- Kafka, ClickHouse, and Postgres connectivity from the execution environment.
- A dataset manifest file (YAML/JSON) with explicit `window.start` and `window.end`.

## Step 1: Prepare Manifest

Start from `services/torghut/config/simulation/example-dataset.yaml` and set:

- `dataset_id`
- `window.profile=us_equities_regular`, `window.trading_day`, and matching session `start/end`
- `clickhouse.simulation_database` (example: `torghut_sim_<run_token>`)
- `postgres.simulation_dsn_template` or `postgres.simulation_dsn`
- `argocd.manage_automation=true` and ApplicationSet/app names
- `torghut_env_overrides` for simulation-only runtime knobs (allowlist enforced by script)

Recommendation:

- use a dedicated Postgres DB per run (`torghut_sim_<run_token>`),
- keep `replay.pace_mode=accelerated` for faster empirical runs.
- by default, the script auto-derives `TRADING_FEATURE_MAX_STALENESS_MS` from `window.start`.
- set `torghut_env_overrides.TRADING_FEATURE_MAX_STALENESS_MS` only for an explicit custom budget.
- set `monitor.*` thresholds for minimum decisions/executions/TCA rows.

## Step 2: Plan

From `services/torghut`:

```bash
RUN_ID=sim-2026-02-28-01
MANIFEST=config/simulation/example-dataset.yaml

uv run python scripts/start_historical_simulation.py \
  --mode plan \
  --run-id "${RUN_ID}" \
  --dataset-manifest "${MANIFEST}"
```

Verify plan output shows isolated targets:

- `clickhouse_database` is not `torghut`
- `postgres_database` is not `torghut`
- simulation topics are `torghut.sim.*`

## Step 3: Run Simulation End-to-End

`start_historical_simulation.py --mode run` handles:

- Argo automation switch to `manual` (if manifest enables management),
- apply (dump/replay/configure),
- monitor until cursor reaches run window and thresholds are met,
- post-run report generation,
- teardown + Argo automation restore.

```bash
uv run python scripts/start_historical_simulation.py \
  --mode run \
  --run-id "${RUN_ID}" \
  --dataset-manifest "${MANIFEST}" \
  --confirm START_HISTORICAL_SIMULATION
```

For reruns with existing dump/replay:

```bash
uv run python scripts/start_historical_simulation.py \
  --mode run \
  --run-id "${RUN_ID}" \
  --dataset-manifest "${MANIFEST}" \
  --confirm START_HISTORICAL_SIMULATION \
  --force-replay
```

## Step 4: Validate Simulation Runtime (During Run)

1. Validate Torghut simulation env:

```bash
kubectl get ksvc torghut -n torghut -o jsonpath='
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_MODE")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_LIVE_ENABLED")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_EXECUTION_ADAPTER")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_SIMULATION_ENABLED")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_SIGNAL_TABLE")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_FEATURE_MAX_STALENESS_MS")].value}{"\n"}'
```

Expected values:

- `paper`
- `false`
- `simulation`
- `true`
- `<simulation_db>.ta_signals`
- `<historical override value>` (for example `43200000`)

2. Validate TA topic rewiring:

```bash
kubectl get configmap torghut-ta-config -n torghut -o jsonpath='
{.data.TA_TRADES_TOPIC}{"\n"}
{.data.TA_QUOTES_TOPIC}{"\n"}
{.data.TA_BARS1M_TOPIC}{"\n"}
{.data.TA_SIGNALS_TOPIC}{"\n"}
{.data.TA_GROUP_ID}{"\n"}'
```

Expected values are `torghut.sim.*` topics and `TA_GROUP_ID=torghut-ta-sim-<run_token>`.

3. Validate replay evidence artifact:

`artifacts/torghut/simulations/<run_token>/run-manifest.json`:

- `replay.records` > 0
- `replay.records_by_topic` populated
- `dump.sha256` present
- `dump_coverage` present and passing
- `window_policy` present

## Step 5: Collect Empirical Evidence

Collect all of:

- `run-manifest.json`
- `run-full-lifecycle-manifest.json`
- `run-state.json`
- `source-dump.replay-marker.json`
- `report/simulation-report.json`
- `report/simulation-report.md`
- `report/trade-pnl.csv`
- `report/execution-latency.csv`
- `report/llm-review-summary.csv`
- Torghut `/trading/status` snapshot
- TA + Torghut logs for the run window
- Postgres row counts in simulation DB:
  - `trade_decisions`
  - `executions`
  - `execution_order_events`
  - `execution_tca_metrics`
- ClickHouse row counts in simulation DB:
  - `ta_microbars`
  - `ta_signals`

Postgres count query:

```bash
kubectl cnpg psql -n torghut torghut-db -- -U postgres -d "<simulation_db>" -c "
SELECT 'trade_decisions' AS table, count(*) AS rows FROM trade_decisions
UNION ALL SELECT 'executions', count(*) FROM executions
UNION ALL SELECT 'execution_order_events', count(*) FROM execution_order_events
UNION ALL SELECT 'execution_tca_metrics', count(*) FROM execution_tca_metrics;"
```

ClickHouse count query (memory-safe via `system.parts`):

```bash
kubectl exec -i -n torghut chi-torghut-clickhouse-default-0-0-0 -- \
  clickhouse-client --host 127.0.0.1 --port 9000 \
  --user torghut --password "${TORGHUT_CLICKHOUSE_PASSWORD}" \
  --query "SELECT table, sum(rows) AS rows
           FROM system.parts
           WHERE active=1 AND database='<simulation_db>'
           GROUP BY table ORDER BY table FORMAT TabSeparated"
```

## Step 6: Split-Mode Teardown (Only if you did not use `--mode run`)

```bash
uv run python scripts/start_historical_simulation.py \
  --mode teardown \
  --run-id "${RUN_ID}" \
  --dataset-manifest "${MANIFEST}"
```

Verify:

- `TA_*_TOPIC` values restored to production topics
- `TA_GROUP_ID` restored to production value
- Torghut restored to `TRADING_MODE=live`, `TRADING_EXECUTION_ADAPTER=lean`
- `TRADING_SIMULATION_ENABLED` unset

## Step 7: Verify Argo Automation Restore

When `argocd.manage_automation=true`, the script restores the previously captured automation mode.
Verify after run:

```bash
kubectl annotate application torghut -n argocd argocd.argoproj.io/refresh=hard --overwrite
kubectl get application torghut -n argocd -o jsonpath='
{.status.sync.status}{"\n"}
{.status.health.status}{"\n"}
{.status.sync.revision}{"\n"}
{.status.operationState.phase}{"\n"}'
```

Expected: `Synced`, `Healthy`, and `Succeeded`.

## Known Issues (as of 2026-02-28)

1. Argo automation management can fail if ApplicationSet path structure changes.

- Mitigation: keep `argocd.applicationset_name/app_name` manifest settings current and verify `run-state.json` phase status.

2. Simulation ClickHouse DB may not contain `ta_microbars`/`ta_signals` tables automatically.

- Symptom: Torghut log contains `clickhouse_http_404` unknown table in simulation DB.
- Mitigation: create simulation tables before running TA/Torghut against the simulation DB.

```sql
CREATE TABLE IF NOT EXISTS <simulation_db>.ta_microbars ON CLUSTER default
AS torghut.ta_microbars
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/<simulation_db>_ta_microbars',
  '{replica}',
  ingest_ts
);

CREATE TABLE IF NOT EXISTS <simulation_db>.ta_signals ON CLUSTER default
AS torghut.ta_signals
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{cluster}/{shard}/<simulation_db>_ta_signals',
  '{replica}',
  ingest_ts
);
```

3. Replay can advance cursor but produce zero decisions/executions.

- Typical causes:
  - replay window timestamps are outside market/actionable logic,
  - cursor already at replay tail,
  - strategy gates reject all signals,
  - historical staleness exceeds live quality budget and batches are rejected pre-decision.
- Mitigation:
  - verify `run-full-lifecycle-manifest.json.monitor`,
  - use a day/window known to produce production decisions,
  - rely on auto-derived staleness budget from `window.start` (or explicit override),
  - ensure monitor thresholds are configured and fail-closed,
  - reset/inspect simulation `trade_cursor` when re-running with the same DB.

## Completion Checklist

- [ ] Plan output validated (`isolated db/topics`)
- [ ] Apply completed (`status=ok`, replay count > 0)
- [ ] Run completed (`status=ok`, monitor thresholds met)
- [ ] Simulation runtime validated (`paper`, `simulation`, isolated tables/topics)
- [ ] Statistical report captured (`simulation-report.json/.md + CSV exports`)
- [ ] Empirical evidence captured (artifacts + DB/ClickHouse counts + status snapshot)
- [ ] Teardown completed (`status=ok`, or split-mode manual teardown done)
- [ ] Argo automation restored to previous mode
- [ ] Application healthy and synced on production revision
