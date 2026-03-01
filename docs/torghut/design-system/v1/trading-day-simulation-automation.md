# Trading-Day Simulation Automation for Torghut (v1 Design)

## Status

- Version: `v1`
- Date: `2026-02-28`
- Scope: automation strategy and runbook for recurring trading-day replay simulations
- Source of truth (runtime): `start_historical_simulation.py` and live cluster config
- Implementation status: `Planned`
- Implementation evidence: `services/torghut/scripts/start_historical_simulation.py`, `services/torghut/scripts/analyze_historical_simulation.py`, `docs/torghut/rollouts/historical-simulation-playbook.md`
- Implementation gaps: no dedicated `automate_trading_day_simulation.py` orchestrator, no production CronJob/Temporal workflow for batch-day simulation windows, and no persisted day-run registry schema.
- Rollout and verification:
  - ship and version `services/torghut/scripts/automate_trading_day_simulation.py`,
  - run at least one dry-run day from a staging manifest repository,
  - enforce pre/post contamination query checks and archive day artifacts under `artifacts/torghut/simulations/<run_token>/`.

## Purpose

Define a safe, deterministic, and repeatable automation flow that runs one or more
Torghut historical simulations per trading day (or historical window) with zero
manual cluster patching.

The design intentionally builds on the existing production runtime contracts:

- `services/torghut/scripts/start_historical_simulation.py`
- `docs/torghut/design-system/v1/historical-dataset-simulation.md`
- `docs/torghut/rollouts/historical-simulation-playbook.md`

## Non-goals

- Replacing trading strategy logic.
- Promoting paper candidates to live automatically.
- Re-implementing market-day calendars or Kafka utilities from scratch.

## Definitions

- **Trading day**: A New York market session day (currently Mon–Fri by default).
- **Trading-session window**: `09:30` to `16:00 America/New_York` by default, with configurable buffer.
- **Simulation run**: One `start_historical_simulation.py` apply/teardown cycle driven by a per-day dataset manifest.
- **Paper-only**: `TRADING_MODE=paper`, `TRADING_LIVE_ENABLED=false`, `TRADING_EXECUTION_ADAPTER=simulation`.

```mermaid
flowchart TD
  A["Day planner"] --> B["Manifest generator (per run)"]
  B --> C["start_historical_simulation --mode plan"]
  C --> D["start_historical_simulation --mode apply"]
  D --> E["Replay + Kafka isolation checks"]
  E --> F["Torghut/TA simulation window"]
  F --> G["Evidence capture"]
  G --> H["start_historical_simulation --mode teardown"]
  H --> I["Day registry update + next run"]
```

## Core automation model

### 1) Day planner service

The planner resolves candidate trading days and window bounds in UTC for the
simulation orchestrator.

Inputs:

- `--from-date` and `--to-date` (`YYYY-MM-DD`, New York date semantics)
- optional `--calendar-filter` (`strict`/`skip-empty`)
- optional `--dry-run` and `--max-parallel-days`

Behavior:

- Map each candidate NY date to a UTC range:
  - `window_start = NY(session_start - prebuffer)`
  - `window_end = NY(session_end + postbuffer)`
- `skip` weekends when `calendar-filter=strict` is enabled.
- Optional skip optimization: emit no-op when manifest window contains zero records
  in source topics.
- Generate deterministic:
  - `run_id = sim-<YYYYMMDD>-<sequence>`
  - `dataset_id = torghut-trades-<YYYYMMDD>`
  - `run_token` from `run_id` normalization.

### 2) Manifest generator

For each run, generate a temporary or committed manifest with:

```yaml
dataset_id: torghut-trades-2026-02-28
window:
  start: '2026-02-28T14:00:00Z'
  end: '2026-02-28T21:30:00Z'

kafka:
  bootstrap_servers: kafka-kafka-bootstrap.kafka:9092
  security_protocol: SASL_PLAINTEXT
  sasl_mechanism: SCRAM-SHA-512
  sasl_username: torghut-ws
  sasl_password_env: TORGHUT_SIM_KAFKA_PASSWORD

clickhouse:
  http_url: http://torghut-clickhouse.torghut.svc.cluster.local:8123
  username: torghut
  password: ''
  simulation_database: torghut_sim_2026_02_28

postgres:
  admin_dsn: postgresql://torghut:torghut@postgres-rw.torghut.svc.cluster.local:5432/postgres
  simulation_dsn_template: postgresql://torghut:torghut@postgres-rw.torghut.svc.cluster.local:5432/{db}
  migrations_command: uv run --frozen alembic upgrade head

replay:
  pace_mode: accelerated
  acceleration: 60
  max_sleep_seconds: 5
  auto_offset_reset: earliest

torghut_env_overrides:
  TRADING_FEATURE_QUALITY_ENABLED: 'true'
  TRADING_FEATURE_MAX_STALENESS_MS: '43200000'
```

The orchestrator may persist these manifests under:

- `artifacts/torghut/simulations/<run_token>/manifest.yaml`

### 3) Simulation runner lifecycle

Each run follows this sequence:

1. **Preflight**
   - `uv run python scripts/start_historical_simulation.py --mode plan --run-id <run_id> --dataset-manifest <path>`
   - Validate script-level isolation guard output and runtime plan sanity checks.
2. **Apply**
   - `--mode apply --confirm START_HISTORICAL_SIMULATION`
   - Ensure patch state is captured and run manifest is written.
3. **Monitor and gate**
   - Wait for `kservice` env checks:
     - `TRADING_MODE=paper`
     - `TRADING_LIVE_ENABLED=false`
     - `TRADING_EXECUTION_ADAPTER=simulation`
     - `TRADING_SIMULATION_ENABLED=true`
     - `TRADING_SIGNAL_TABLE=<simulation_db>.ta_signals`
   - Wait for TA to resume and consume simulation topics.
4. **Evidence capture**
   - Persist row-count deltas from simulation Postgres and ClickHouse.
   - Persist runtime KPIs in orchestration artifact.
5. **Teardown**
   - `--mode teardown --run-id <run_id> --dataset-manifest <path>`
   - Restore captured TA + torghut environment.
6. **Registry update**
   - Record success/failure + evidence paths + run hash in a day-run index file.

### 4) Idempotency and resume

- `run_id` is stable; re-running same `run_id` may reuse manifest/dump with explicit
  `--force-replay` only when an explicit rerun is required.
- Runner writes a lock file:
  - `artifacts/torghut/simulations/<run_token>/inflight.lock`
  - prevents concurrent overlapping runs.
- Any run that fails after apply automatically attempts teardown (best effort),
  emits `recovery` status, and leaves explicit operator action items if rollback fails.

## Scheduling model

### Baseline cadence

- Nightly automation for the previous completed trading day:
  - trigger at `21:00 America/New_York` local cluster time.
  - window date = previous NY trading day.
- Backfill mode:
  - explicit date range with bounded bounds (e.g., 10 recent sessions).

### Recommendation

- Start with `CronJob` in torghut namespace calling a single orchestrator script.
- Future state: migrate to a dedicated AgentRun/Temporal workflow for richer SLAs
  and audit trail.

## Failure model and controls

| Failure                                      | Detection                       | Automation behavior                                                                                                           |
| -------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Argo self-heal reverting config              | config drift checks after apply | run enters `blocked_config_drift` and skips simulation; optional temporary `manual` automation mode toggle included in runner |
| Isolation guard failure                      | preflight check exception       | do not apply; emit no side-effects                                                                                            |
| Kafka replay zero rows for all source topics | dump summary counters = 0       | mark run `empty_day`, teardown immediately, store artifact as advisory only                                                   |
| Cluster patch failure                        | kubectl command failure         | teardown best-effort (if state captured), fail with `patch_fail`                                                              |
| simulation loop crash before teardown        | missing completion marker       | orchestrator attempts teardown with bounded retries, then marks `manual_cleanup_required`                                     |
| data leakage into production DB/topics       | pre/post contamination query    | hard fail + immediate cleanup request                                                                                         |

## Evidence outputs

For each trading-day run, create and persist:

- `plan.json` (plan validation payload)
- `run-manifest.json` (post-apply status from starter script)
- `teardown-manifest.json` (post-teardown state)
- `source-dump.ndjson` (raw replay source)
- `replay-marker` metadata and dump hash
- `day-report.json` (orchestrator metadata: session bounds, status, run_id, db/topic names, sample metrics)

Recommended minimum KPIs:

- `dump.records_total` and `dump.records_by_topic`
- `replay.records_total`
- `trade_decisions.total`, `executions.total`, `execution_order_events.total`
- `execution_tca_metrics.total`
- `torghut_trading_*` metrics for decision/reject/reconcile deltas

## Security and safety invariants

- No run writes to production DB or ClickHouse namespace.
- Simulation artifacts must remain in isolated database names (`torghut_sim_*`) and simulation topics (`torghut.sim.*`).
- Always set:
  - `TRADING_MODE=paper`
  - `TRADING_LIVE_ENABLED=false`
  - `TRADING_EXECUTION_ADAPTER=simulation`
  - `TRADING_SIMULATION_ENABLED=true`
- `TRADING_UNIVERSE_SOURCE` remains `jangar` (matches existing runtime hard constraints when trading is active).

## Recommended implementation tasks

1. Add orchestrator script:
   - `services/torghut/scripts/automate_trading_day_simulation.py`
   - supports `plan-batch`, `apply-day`, `run-day`, `teardown-day`, `resume-day`.
2. Add optional helper manifest template:
   - `services/torghut/config/simulation/trading-day-template.yaml`
3. Add orchestration state model:
   - `artifacts/torghut/simulations/<run_token>/day-run.json`
4. Add scheduler manifest or cron wrapper:
   - `CronJob` or CI scheduled workflow invoking one-day replay for `--auto-previous-day`.
5. Add regression tests:
   - unit: timezone conversion, date-window generation, run-id derivation.
   - script test: idempotent rerun + failure-at-step recovery behavior.

## Exit criteria

- A daily run can be started with one command and produces complete evidence without manual
  TA/torghut patching.
- Empty/non-trading days are safely skipped with explicit `empty_day` status.
- Every applied run is torn down and restores environment in the same pass (or fails loudly with explicit cleanup tasks).
- No production table/topic writes are observed during simulated runs.

## Open question

- Choose first-class source of trading-calendar truth:
  - fixed NY weekday windows + empty-day detection, or
  - external exchange calendar API integration for holidays.
