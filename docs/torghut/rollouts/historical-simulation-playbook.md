# Historical Simulation Playbook

Last updated: **2026-03-12**

This playbook is the production run procedure for Torghut historical simulations using
`services/torghut/scripts/start_historical_simulation.py` on the dedicated simulation surfaces.

It is designed for runs that must preserve production safety while producing empirical evidence.

## Scope

Use this playbook when you need to:

- replay bounded historical topic windows into simulation topics,
- run TA + Torghut with simulation storage/topic isolation,
- collect measured outcomes from signals through execution metadata,
- restore dedicated simulation runtime settings after the run.

## Safety Guardrails

- Never run `apply` without a unique `run_id`.
- Never run simulation with production Postgres/ClickHouse targets.
- Keep Torghut in paper mode during simulation (`TRADING_MODE=paper` and `TRADING_EXECUTION_ADAPTER=simulation`).
- Do not expect `TRADING_LIVE_ENABLED` to appear as an explicit Knative env override during simulation validation.
  The runtime now treats it as a deprecated derived setting from `TRADING_MODE`.
- Run `teardown` in the same `run_id` immediately after evidence collection.
- Keep `runtime.target_mode=dedicated_service` and `argocd.manage_automation=true` in the manifest so the script uses
  the dedicated simulation services and restores automation correctly.

## Prerequisites

- Argo CD app `argo-rollouts` synced and healthy.
- Rollouts CRDs available:
  - `analysisruns.argoproj.io`
  - `analysistemplates.argoproj.io`
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
- `postgres.admin_dsn` must point at the bootstrap/superuser role for isolated database creation + migrations
- `postgres.simulation_dsn_template` or `postgres.simulation_dsn` must point at the Torghut runtime role
- `postgres.simulation_dsn_password_env=TORGHUT_POSTGRES_PASSWORD`
- `postgres.runtime_simulation_dsn_password_env=TORGHUT_POSTGRES_PASSWORD`
- `postgres.admin_dsn_password_env=TORGHUT_POSTGRES_ADMIN_PASSWORD`
- `runtime.target_mode=dedicated_service`
- `argocd.manage_automation=true` and ApplicationSet/app names
- `torghut_env_overrides` for simulation-only runtime knobs (allowlist enforced by script)

Recommendation:

- use a dedicated Postgres DB per run (`torghut_sim_<run_token>`),
  - prefer `replay.pace_mode=max_throughput` for full-day deterministic runs to avoid artificial delays from sparse historical gaps;
  - use `status_update_every_seconds` and `status_update_every_records` to control heartbeat cadence.
- by default, the script auto-derives `TRADING_FEATURE_MAX_STALENESS_MS` from `window.start`.
- set `torghut_env_overrides.TRADING_FEATURE_MAX_STALENESS_MS` only for an explicit custom budget.
- set `monitor.*` thresholds for minimum decisions/executions/TCA rows.

Kafka credential handling:

- `runtime_sasl_password_env` should stay `TORGHUT_SIM_KAFKA_PASSWORD`.
- Do not pass plaintext credentials in commands or manifests.
- Ensure the Kubernetes secret name in the workflow is `kafka-codex-credentials` and the key is `password`.

Expected dedicated resources:

- `Service/torghut-sim`
- `FlinkDeployment/torghut-ta-sim`
- `ConfigMap/torghut-ta-sim-config`
- `Service/torghut-forecast-sim`
- `AnalysisTemplate/torghut-simulation-runtime-ready`
- `AnalysisTemplate/torghut-simulation-activity`
- `AnalysisTemplate/torghut-simulation-teardown-clean`

This playbook is Argo-first. The canonical execution engine is still
`services/torghut/scripts/start_historical_simulation.py`; the WorkflowTemplate is a thin wrapper around that script.

Phase 1 note:

- Argo Workflows remains the simulation orchestrator.
- Argo Rollouts is used as the gate/control plane via `AnalysisTemplate` and `AnalysisRun`.
- `torghut-sim` and `torghut-ta-sim` are not migrated to `Rollout` resources in this phase.

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
- runtime verification through an `AnalysisRun`,
- activity verification through an `AnalysisRun`,
- post-run report generation,
- fill-price error budget generation and completion-trace persistence,
- teardown + Argo automation restore,
- teardown cleanliness verification through an `AnalysisRun`.

Observe the gate plane while the workflow is running:

```bash
kubectl get analysisrun -n torghut -w
```

Expected AnalysisRuns per simulation run:

- `torghut-sim-runtime-ready-<run-token>`
- `torghut-sim-activity-<run-token>`
- `torghut-sim-teardown-clean-<run-token>`

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

Leave `forceDump` and `forceReplay` unset/false to reuse existing dump and replay markers for the same `run_id`.
Use `-p forceDump=true` to capture a fresh source dump and `-p forceReplay=true` to republish an existing dump into the
simulation topics.

## Step 4: Validate Simulation Runtime (During Run)

1. Validate Torghut simulation env on `torghut-sim`:

```bash
kubectl get ksvc torghut-sim -n torghut -o jsonpath='
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_MODE")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_EXECUTION_ADAPTER")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_SIMULATION_ENABLED")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_SIGNAL_TABLE")].value}{"\n"}
{.spec.template.spec.containers[0].env[?(@.name=="TRADING_FEATURE_MAX_STALENESS_MS")].value}{"\n"}'
```

Expected values:

- `paper`
- `simulation`
- `true`
- `<simulation_db>.ta_signals`
- `<historical override value>` (for example `43200000`)

If you need to confirm the deprecated live/paper compatibility field, query `/trading/status` or service logs instead of
expecting a literal `TRADING_LIVE_ENABLED` env entry on the Knative revision.

2. Validate TA topic rewiring on `torghut-ta-sim-config`:

```bash
kubectl get configmap torghut-ta-sim-config -n torghut -o jsonpath='
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
  - latest `RUN_STATE ...` lines visible in argo logs showing `subphase=replay` with non-zero records while waiting
 - `dump_coverage` present and passing
 - `window_policy` present
 - `ta_restore.mode` present
 - `ta_restore.effective_upgrade_mode` present
 - if fallback was used, `ta_restore.fallback_applied=true` with explicit `reason`
 - `rollouts.runtime_analysis_run` populated after runtime gate completes
 - `rollouts.activity_analysis_run` populated after activity gate completes

`artifacts/torghut/simulations/<run_token>/runtime-verify.json`:

- `schema_registry.ready=true`
- `analysis_images.ready=true`
- `ta_runtime.upgrade_mode` matches the run intent (`last-state` or explicit `stateless`)
- `ta_runtime.restore_state_reason` is absent for healthy runs
- `runtime_state=ready`

Interpretation shortcuts:

- `schema_registry.reason=schema_subject_missing`: replay infra is incomplete; do not trust downstream activity gates.
- `analysis_images.reason=analysis_image_stale`: analysis templates are not running the same Torghut image as the service under test.
- `ta_runtime.restore_state_reason=restore_state_missing`: TA restore configuration or restore state is missing; rerun with an explicit simulation stateless recovery mode only if that is the intended experiment.
- `trade_decisions > 0` with `execution_submit_attempt_total == 0`: decisioning is healthy but the pipeline is not reaching execution.
- `execution_submit_attempt_total > 0` with zero accepted results: inspect `execution_local_reject_total`, `qty_resolution_total`, and `execution_validation_mismatch_total` before treating the run as an alpha problem.

## Step 5: Collect Empirical Evidence

Collect all of:

- `run-manifest.json`
- `run-full-lifecycle-manifest.json`
- `run-state.json`
- `runtime-verify.json`
- `signal-activity.json`
- `decision-activity.json`
- `execution-activity.json`
- `source-dump.replay-marker.json`
- `report/simulation-report.json`
- `report/simulation-report.md`
- `report/trade-pnl.csv`
- `report/execution-latency.csv`
- `report/llm-review-summary.csv`
- Torghut `/trading/status` snapshot
- TA + Torghut logs for the run window
- `AnalysisRun` YAML/status for runtime, activity, and teardown gates
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

Gate inspection:

```bash
kubectl get analysisrun -n torghut
kubectl get analysisrun -n torghut torghut-sim-runtime-ready-<run_token> -o yaml
kubectl get analysisrun -n torghut torghut-sim-activity-<run_token> -o yaml
kubectl get analysisrun -n torghut torghut-sim-teardown-clean-<run_token> -o yaml
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

- `torghut-ta-sim-config` returns to the neutral sim defaults expected by GitOps
- `TA_GROUP_ID` no longer carries the run-specific suffix
- `torghut-sim` no longer carries run-scoped DB/topic overrides
- the live `torghut` service revision and traffic remain unchanged because the dedicated-service path never mutates them

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

## Known Issues (as of 2026-03-12)

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

6. One-hour simulation replay can produce TA outputs but still fail pre-decision on feature quality.

- Confirmed on `2026-03-12` for the `2026-03-11T13:30:00Z -> 2026-03-11T14:30:00Z` smoke replay.
- Observed sequence:
  - replay published successfully,
  - simulation ClickHouse filled `ta_microbars` and `ta_signals`,
  - Torghut logged repeated `Feature quality gate failed ... reasons=['non_monotonic_progression']`,
  - `trade_decisions` and `executions` remained `0`.
- Root cause was sequential:
  - the simulation script configures `TRADING_SIGNAL_ALLOWED_SOURCES=ws,ta` in [`start_historical_simulation.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/scripts/start_historical_simulation.py#L2715), so mixed-source batches can contain a `ws` row with a large `seq` followed by `ta` rows that restart at `seq=1`,
  - even after narrowing to `ta` only for diagnosis, the deployed ingest path still returned multi-symbol rows in ClickHouse query order when no dedupe occurred, while the feature-quality gate validates monotonicity on `(event_ts, symbol, seq)`.
- Relevant code:
  - ingest fetch path returns `_filter_signals(self._dedupe_signals(signals))` at [`ingest.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/app/trading/ingest.py#L782),
  - `_dedupe_signals()` only sorts when dedupe removed at least one row at [`ingest.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/app/trading/ingest.py#L791),
  - feature quality marks the batch non-monotonic from `(signal.event_ts, signal.symbol, signal.seq or 0)` at [`feature_quality.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/app/trading/feature_quality.py#L132),
  - the scheduler rejects and commits cursor immediately at [`pipeline.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/app/trading/scheduler/pipeline.py#L222).
- Operational guidance:
  - do not interpret fresh TA tables as proof that Torghut is evaluating signals,
  - if logs show `non_monotonic_progression`, inspect the actual `ta_signals` ordering before debugging strategy logic,
  - treat temporary `ta`-only overrides as diagnostic only; the durable fix is to guarantee deterministic sort order before feature-quality evaluation.

7. A replay can create `trade_decisions` and still produce zero executions because local pre-submit validation rejects fractional opening-short equity orders.

- Confirmed on `2026-03-12` in the same replay after the signal path progressed far enough to persist decisions.
- Observed state:
  - `trade_decisions = 10`,
  - `executions = 0`,
  - all decisions ended in `status=rejected`,
  - Torghut logs showed repeated `local_qty_invalid_increment` for `INTC` with quantities around `1.5860-1.5879`.
- Rejection log signature:
  - `reject_reason="qty increment invalid; step=1"`
  - `source="local_pre_submit"`
  - `code="local_qty_invalid_increment"`
- Relevant code:
  - rejection is raised in [`execution.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/app/trading/execution.py#L1236),
  - execution-side fractional gating is derived by `_fractional_equities_enabled_for_request()` in [`execution.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/app/trading/execution.py#L776),
  - `fractional_equities_enabled_for_trade()` disables fractional sizing for `sell` requests when `position_qty <= 0` in [`quantity_rules.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/app/trading/quantity_rules.py#L56),
  - the simulation adapter reports no current positions from `list_positions()` in [`execution_adapters.py`](/Users/gregkonush/.codex/worktrees/4b2e/lab/services/torghut/app/trading/execution_adapters.py#L285).
- This means a replay can size a fractional `sell` from decision/portfolio logic and still fail at execution time when that sell is treated as a short-increasing order with a whole-share step.
- Operational guidance:
  - do not treat nonzero `trade_decisions` as execution proof,
  - inspect `trade_decisions.status` and the `broker_precheck` payload inside `decision_json`,
  - if all decisions are rejected with local increment errors on `sell` orders and the adapter has no existing positions, verify whether the replay is attempting fractional opening shorts rather than assuming the simulation adapter is broken.

8. Replay verification for `mode=run` should be interpreted as a staged pipeline, not a single binary verdict.

- The `2026-03-12` replay proved three separate checkpoints:
  - upstream replay + TA materialization can succeed after infra repair,
  - Torghut can progress from `0` to persisted `trade_decisions`,
  - execution can still be blocked locally afterward.
- Use this order when triaging:
  1. `ta_microbars` / `ta_signals` row counts
  2. feature-quality rejection logs
  3. `trade_decisions` count and status distribution
  4. `executions`, `execution_order_events`, and `execution_tca_metrics`
- A run is not execution-valid until all four layers are nonzero and internally consistent.

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
