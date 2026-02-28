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
- Re-enable Argo automation after teardown if it was temporarily disabled.

## Prerequisites

- `kubectl` access to the target cluster and namespace (`torghut`).
- Python runtime + dependencies for the script (`uv sync --frozen --extra dev` in `services/torghut`).
- Kafka, ClickHouse, and Postgres connectivity from the execution environment.
- A dataset manifest file (YAML/JSON) with explicit `window.start` and `window.end`.

## Step 1: Prepare Manifest

Start from `services/torghut/config/simulation/example-dataset.yaml` and set:

- `dataset_id`
- `window.start` and `window.end` (RFC3339 UTC, explicit timestamps)
- `clickhouse.simulation_database` (example: `torghut_sim_<run_token>`)
- `postgres.simulation_dsn_template` or `postgres.simulation_dsn`

Recommendation:

- use a dedicated Postgres DB per run (`torghut_sim_<run_token>`),
- keep `replay.pace_mode=accelerated` for faster empirical runs.

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

## Step 3: Temporarily Disable Argo Auto-Reconcile

`start_historical_simulation.py` patches runtime ConfigMap/KService fields. If Argo automation remains enabled, those
patches are reverted almost immediately.

Set the `torghut` entry in `ApplicationSet/product` to `automation=manual` before `apply`.

```bash
INDEX=$(
  kubectl get applicationset product -n argocd -o json \
    | jq -r '.spec.generators[0].matrix.generators[1].list.elements
      | to_entries[]
      | select(.value.name=="torghut")
      | .key'
)

kubectl patch applicationset product -n argocd --type json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/generators/0/matrix/generators/1/list/elements/${INDEX}/automation\",\"value\":\"manual\"}]"
```

## Step 4: Apply Simulation

```bash
uv run python scripts/start_historical_simulation.py \
  --mode apply \
  --run-id "${RUN_ID}" \
  --dataset-manifest "${MANIFEST}" \
  --confirm START_HISTORICAL_SIMULATION
```

For repeat runs with the same dump:

```bash
uv run python scripts/start_historical_simulation.py \
  --mode apply \
  --run-id "${RUN_ID}" \
  --dataset-manifest "${MANIFEST}" \
  --confirm START_HISTORICAL_SIMULATION \
  --force-replay
```

## Step 5: Validate Simulation Runtime

1. Validate Torghut simulation env:

```bash
kubectl get ksvc torghut -n torghut -o jsonpath='
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_MODE")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_LIVE_ENABLED")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_EXECUTION_ADAPTER")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_SIMULATION_ENABLED")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_SIGNAL_TABLE")].value}{"\n"}'
```

Expected values:

- `paper`
- `false`
- `simulation`
- `true`
- `<simulation_db>.ta_signals`

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

## Step 6: Collect Empirical Evidence

Collect all of:

- `run-manifest.json`
- `source-dump.replay-marker.json`
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

## Step 7: Teardown

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

## Step 8: Re-enable Argo Automation

Revert `ApplicationSet/product` torghut element back to `automation=auto`:

```bash
kubectl patch applicationset product -n argocd --type json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/generators/0/matrix/generators/1/list/elements/${INDEX}/automation\",\"value\":\"auto\"}]"
```

Then force refresh and verify:

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

1. Argo auto/self-heal reverts runtime simulation patches.

- Mitigation: switch `automation` to `manual` before `apply`; switch back to `auto` after teardown.

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

3. Replay can succeed while producing zero executions.

- Typical causes:
  - replay window timestamps are outside market/actionable logic,
  - cursor already at replay tail,
  - strategy gates reject all signals.
- Mitigation:
  - verify `/trading/status` (`last_ingest_signal_count`, `last_reason`),
  - use a window known to produce production decisions,
  - reset/inspect simulation `trade_cursor` when re-running with the same DB.

## Completion Checklist

- [ ] Plan output validated (`isolated db/topics`)
- [ ] Apply completed (`status=ok`, replay count > 0)
- [ ] Simulation runtime validated (`paper`, `simulation`, isolated tables/topics)
- [ ] Empirical evidence captured (artifacts + DB/ClickHouse counts + status snapshot)
- [ ] Teardown completed (`status=ok`)
- [ ] Argo automation restored (`auto`)
- [ ] Application healthy and synced on production revision
