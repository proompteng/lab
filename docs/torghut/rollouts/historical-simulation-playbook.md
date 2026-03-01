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
- Access to the cluster services for Kafka, ClickHouse, and Postgres from Argo workflow runtime.
- A dataset manifest file (YAML/JSON) with explicit `window.start` and `window.end`.
- A reflected Strimzi KafkaUser password in `argo-workflows`:

```bash
kubectl get secret kafka-codex-credentials -n argo-workflows -o jsonpath='{.data.password}' >/dev/null
```

This secret is reflected from the Strimzi `KafkaUser kafka-codex-credentials` in namespace `kafka` via `kubernetes-reflector` annotations, so password rotation is handled at source.

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

Kafka credential handling:

- `runtime_sasl_password_env` should stay `TORGHUT_SIM_KAFKA_PASSWORD`.
- Do not pass plaintext credentials in commands or manifests.
- Ensure the Kubernetes secret name in the workflow is `kafka-codex-credentials` and the key is `password`.

This playbook is Argo-first and should not be executed locally.

## Step 2: Plan (Argo)

```bash
RUN_ID=sim-2026-02-27-01
MANIFEST=config/simulation/example-dataset.yaml
MANIFEST_B64="$(base64 < "${MANIFEST}" | tr -d '\n')"

argo submit --from workflowtemplate/torghut-historical-simulation \
  -n argo-workflows \
  -p runId="${RUN_ID}" \
  -p mode=plan \
  -p datasetManifestB64="${MANIFEST_B64}"

```

Verify plan output shows isolated targets:

- `clickhouse_database` is not `torghut`
- `postgres_database` is not `torghut`
- simulation topics are `torghut.sim.*`

## Step 3: Run Simulation End-to-End (Argo)

From Argo:

```bash
RUN_ID=sim-2026-02-27-01
MANIFEST=config/simulation/example-dataset.yaml
MANIFEST_B64="$(base64 < "${MANIFEST}" | tr -d '\n')"

argo submit --from workflowtemplate/torghut-historical-simulation \
  -n argo-workflows \
  -p runId="${RUN_ID}" \
  -p mode=run \
  -p confirmPhrase=START_HISTORICAL_SIMULATION \
  -p datasetManifestB64="${MANIFEST_B64}"
```

`start_historical_simulation.py --mode run` handles:

- Argo automation switch to `manual` (if manifest enables management),
- apply (dump/replay/configure),
- monitor until cursor reaches run window and thresholds are met,
- post-run report generation,
- teardown + Argo automation restore.

Workflow pods run in the image environment, so ensure the manifest includes:

```yaml
postgres:
  migrations_command: /opt/venv/bin/python -m alembic upgrade heads
```

- If migration fails with `permission denied to create extension "vector"`, it indicates the configured Postgres role is not superuser. In that case, the script now automatically retries migrations at the pre-vector revision and proceeds with simulation-safe migration state.

For reruns with existing dump/replay:

```bash
RUN_ID=sim-2026-02-27-10
MANIFEST=/tmp/torghut-historical-sim-2026-02-27-manifest-run06.yaml
MANIFEST_B64="$(base64 < "${MANIFEST}" | tr -d '\n')"

argo submit --from workflowtemplate/torghut-historical-simulation \
  -n argo-workflows \
  -p runId="${RUN_ID}" \
  -p mode=run \
  -p confirmPhrase=START_HISTORICAL_SIMULATION \
  -p datasetManifestB64="${MANIFEST_B64}" \
  -p forceReplay=false
```

Track status:

```bash
WORKFLOW_NAME="$(argo submit --from workflowtemplate/torghut-historical-simulation \
  -n argo-workflows \
  -p runId="${RUN_ID}" \
  -p mode=run \
  -p confirmPhrase=START_HISTORICAL_SIMULATION \
  -p datasetManifestB64="${MANIFEST_B64}" \
  -p forceReplay=false -o name | sed 's/workflow.argoproj.io\\/\\///')"
argo wait -n argo-workflows "${WORKFLOW_NAME}"
argo get -n argo-workflows "${WORKFLOW_NAME}"
```

Use `-p forceDump=false` for fresh dumps and `-p forceReplay=true` when replay artifacts already exist.

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

## Step 6: Split-Mode Teardown (Only if you did not use `mode=run`)

```bash
MANIFEST_B64="$(base64 < "${MANIFEST}" | tr -d '\n')"

argo submit --from workflowtemplate/torghut-historical-simulation \
  -n argo-workflows \
  -p runId="${RUN_ID}" \
  -p mode=teardown \
  -p confirmPhrase=START_HISTORICAL_SIMULATION \
  -p datasetManifestB64="${MANIFEST_B64}"
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

1. `manifest.kafka.runtime_sasl_*` fields are required by design, but runbooks should avoid duplicating secrets in manifests by
   using one of:
   - `kafka.runtime_sasl_password_env` with `runtime_sasl_password_env`
   - base `kafka.sasl_password` with `sasl_password_env` plus runtime protocol/security/mechanism settings

   The script now falls back to base Kafka credentials when runtime fields are omitted, which prevents failures when manifests
   accidentally use only the base credentials.

2. Argo automation management can fail if ApplicationSet path structure changes.

- Mitigation: keep `argocd.applicationset_name/app_name` manifest settings current and verify `run-state.json` phase status.

3. Simulation ClickHouse DB may not contain `ta_microbars`/`ta_signals` tables automatically.

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

4. Replay can advance cursor but produce zero decisions/executions.

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

5. `kubectl` is image-owned in `services/torghut/Dockerfile`.

- The workflow no longer downloads `kubectl` at runtime.
- Ensure the Torghut image includes an architecture-correct `kubectl` for your runtime:
  - `/usr/local/bin/kubectl`
  - verify startup with `kubectl version --client`
- If you see `Exec format error`, rebuild `registry.ide-newton.ts.net/lab/torghut` after updating `services/torghut/Dockerfile` with the runtime platform mapping.

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
