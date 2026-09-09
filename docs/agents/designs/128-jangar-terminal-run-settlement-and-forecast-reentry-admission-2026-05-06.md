# 128. Jangar Terminal Run Settlement And Forecast Reentry Admission (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar run settlement, terminal pod debt, safe schedule admission, rollout evidence, Torghut forecast authority,
capital reentry gates, and cross-swarm handoff contracts.

Companion Torghut contract:

- `docs/torghut/design-system/v6/132-torghut-forecast-profit-tournament-and-capital-reentry-guardrails-2026-05-06.md`

Extends:

- `127-jangar-activation-inventory-ledger-and-product-gap-fuses-2026-05-06.md`
- `126-jangar-projection-witness-exchange-and-material-evidence-products-2026-05-06.md`
- `125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`

## Decision

I am selecting a **terminal run settlement and forecast reentry admission** contract for the next Jangar control-plane
step.

The cluster is no longer in the broad outage shape from May 5. In the read-only sample at `2026-05-06T19:25Z`,
`jangar` had `8` running pods, `deployment/jangar` was available, `deployment/agents` was `1/1`, and
`deployment/agents-controllers` was `2/2`. Jangar's control-plane status route reported healthy controller authority,
healthy watch reliability with `3492` AgentRun watch events and `0` errors in the 15-minute window, and a healthy
database projection with `28/28` Kysely migrations applied through
`20260505_torghut_quant_pipeline_health_window_index`.

The failure mode has moved. The agents namespace retained `37` Error pods and `220` Completed pods while the status
route reported `recent_failed_jobs=0` for the current 15-minute window. Recent agents events still showed readiness
probe failures on replaced controller pods. Torghut had fresh market data and fresh empirical jobs, but Jangar's
Torghut forecast segment was degraded with `forecast.status=degraded`, `message=registry_empty`, and no eligible
forecast models. Torghut's own autonomy route agreed: autonomy was disabled, the forecast registry was empty,
Lean authority was scaffold-only, and live rollback emergency stop was inactive.

The selected design does two things together:

1. it settles terminal AgentRun and schedule-runner pods into a compact, queryable run-settlement epoch so retained
   Kubernetes objects stop being the only durable signal of execution debt;
2. it makes forecast reentry a Jangar material action class, so Torghut can use fresh TA and empirical evidence only
   after the forecast registry, proof tournament, and capital guardrails clear.

The tradeoff is another admission product before paper capital can restart. I accept that. A healthy rollout and
fresh ClickHouse rows are not enough to spend capital when the forecast authority is empty. The system needs a precise
path from terminal run cleanup to proof-backed forecast reentry, otherwise we will keep alternating between green
platform surfaces and blocked profit surfaces.

## Runtime Objective And Success Metrics

This contract improves Jangar reliability by reducing terminal execution ambiguity and improving Torghut profitability
by making forecast authority measurable before capital reentry.

Success means:

- Every schedule stage has a terminal settlement watermark independent of retained pod count.
- Normal dispatch can continue only when terminal debt is within the action class budget or a repair lane is active.
- Readiness flaps during rollout are visible as bounded rollout warnings, not as stale terminal pods.
- Forecast reentry is a first-class material action class with `observe`, `paper_canary`, `live_micro_canary`, and
  `live_scale` gates.
- Torghut can run zero-notional forecast tournaments while `registry_empty` is active, but paper/live capital remains
  held until an eligible forecast model and profit claim exist.

## Evidence Snapshot

All checks were read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, broker state,
trading flags, or runtime objects.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was unset and was bootstrapped locally from the in-cluster service-account token.
- Jangar namespace phase count was `Running=8`.
- Jangar serving pod `jangar-6b665898b9-jk27d` was `2/2 Running`; recent events showed a transient readiness refusal
  during rollout warm-up.
- Agents namespace phase count was `Running=7`, `Error=37`, and `Completed=220`.
- `deployment/agents` was `1/1`; `deployment/agents-controllers` was `2/2`.
- Recent agents events showed readiness probe `503` and timeout events on old `agents-controllers` replicas during
  replacement.
- Torghut namespace phase count was `Running=27` and `Completed=4`; live `torghut-00242`, sim `torghut-sim-00343`,
  Postgres, ClickHouse, Keeper, TA, sim TA, options services, websockets, and guardrail exporters were running.
- Recent Torghut events showed warm-up probe failures on live and sim revisions, one bootstrap container mount error,
  and a `flinkdeployment/torghut-ta-sim` `Job Not Found` warning while the current sim TA pods were running.
- CNPG pod exec and cluster-scope CNPG listing were forbidden to this service account; this design assumes privileged
  database internals are not a normal validation surface.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule generation, CronJob reconciliation,
  workspace state, requirements, freezes, and swarm admission. It is the correct source owner for settlement
  watermarks and terminal-debt budgets.
- `services/jangar/src/server/primitives-kube.ts` now supports `PersistentVolumeClaim`, `pvc`, and `pvcs`, so the
  older workspace PVC blind spot is closed. The remaining source risk is terminal-run settlement and admission
  interpretation, not missing primitive types.
- `services/jangar/src/server/control-plane-status.ts` already composes rollout, watch reliability, database,
  workflows, leases, action clocks, controller witness, empirical services, and material action verdicts.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is the right reducer boundary for adding
  `forecast_reentry`, because it already combines Jangar evidence with Torghut capital classes.
- Focused tests exist for control-plane status, action clocks, negative evidence, primitives, supporting schedule
  runners, watch reliability, and Torghut empirical surfaces. The missing regression is terminal pod debt versus
  settled run watermarks, and forecast reentry blocking when forecast authority is `registry_empty`.

### Database And Data Evidence

- Direct Jangar SQL through the app secret connected to database `jangar`.
- Jangar public schema had `54` tables; `kysely_migration` existed with `28` applied migrations and latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar table statistics showed `quant_pipeline_health` at about `50.8M` estimated rows,
  `quant_metrics_series` at about `2.24M`, and `resources_current` at about `3482`.
- Jangar status route reported database `configured=true`, `connected=true`, `status=healthy`, and
  `latency_ms=2`.
- Torghut direct SQL through the app secret connected to database `torghut`; public schema had `69` tables and
  Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Torghut sampled tables showed `trade_decisions=147623`, latest `2026-05-06T17:44:19.618Z`;
  `position_snapshots=42014`, latest `2026-05-06T19:24:48.171Z`; `vnext_empirical_job_runs=20`, latest
  `2026-05-06T16:27:32.941Z`; and `strategies=16`, latest `2026-05-06T11:26:09.535Z`.
- ClickHouse `torghut.ta_microbars` had `1739919` rows, max event timestamp `2026-05-06 19:25:00.000`, and
  `20` symbols.
- ClickHouse `torghut.ta_signals` had `1208172` rows, max event timestamp `2026-05-06 19:24:56.000`, and
  `20` symbols.
- Torghut autonomy reported `last_ingest_signal_count=32`, `signal_continuity.last_state=signals_present`,
  `market_session_open=true`, and `emergency_stop_active=false`.
- Jangar empirical services reported `forecast.status=degraded`, `forecast.message=registry_empty`, `lean.status=disabled`,
  and empirical jobs healthy with eligible jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.

## Problem

Jangar currently has healthy core rollout evidence and live market data, but it does not yet settle the two facts that
matter for the next stage:

1. terminal execution debt is still visible mostly as retained Kubernetes pods;
2. Torghut forecast authority is empty even while signals and empirical jobs are fresh.

Those facts create a dangerous operating shape. If the deployer looks only at rollout and database health, the system
looks ready. If the trader looks only at forecast authority, the system is blocked. If the scheduler looks only at the
last 15 minutes, terminal pod debt disappears. The architecture needs one settlement layer that says which old
executions are closed, which debt still matters, and whether a forecast reentry action can proceed.

## Alternatives Considered

### Option A: Kubernetes TTL Cleanup Only

Add tighter TTLs or cleanup jobs for Completed and Error pods in the agents namespace.

Pros:

- Reduces visual clutter quickly.
- Low implementation cost.
- Does not change Jangar route contracts.

Cons:

- Deletes evidence before it is settled.
- Does not distinguish expected terminal pods from repeated runner failures.
- Does not create a durable admission signal for normal dispatch versus repair dispatch.
- Does not address Torghut forecast reentry or capital safety.

Decision: reject. Cleanup is useful after settlement, not instead of settlement.

### Option B: Keep Forecast Reentry As A Torghut-Only Gate

Let Torghut keep `registry_empty` inside its own autonomy and submission council surfaces while Jangar remains focused
on platform rollout.

Pros:

- Keeps ownership simple.
- Avoids adding a new Jangar material action class.
- Lets Torghut iterate forecast work locally.

Cons:

- Jangar dispatch and deployer stages cannot reason about the profit blocker they are funding.
- Forecast proof jobs can compete with platform repair work without a shared budget.
- The same stale distinction between "platform green" and "capital blocked" persists.

Decision: reject. Jangar does not own trading decisions, but it does own the control-plane admission budget that funds
forecast proof work.

### Option C: Terminal Run Settlement With Forecast Reentry Admission

Create terminal settlement epochs for runner debt and a forecast reentry material action class that consumes Torghut
forecast tournament products.

Pros:

- Preserves terminal evidence before Kubernetes cleanup.
- Gives dispatch, deployer, and Torghut one action-specific admission product.
- Keeps repair lanes open while holding paper/live capital.
- Converts `registry_empty` from a vague degraded state into a named proof task with measurable gates.
- Reuses existing Jangar material action, heartbeat, database, and watch surfaces.

Cons:

- Adds a reducer and route payload.
- Requires feature-flagged rollout to avoid over-blocking normal schedules.
- Requires Torghut to produce compact forecast tournament products instead of only route status.

Decision: select Option C.

## Architecture

Jangar emits a terminal settlement epoch for each control-plane window.

```text
terminal_run_settlement_epoch
  epoch_id
  generated_at
  namespace
  window_start
  window_end
  stage_summaries
  terminal_pod_counts
  unsettled_terminal_refs
  duplicate_attempt_refs
  missing_artifact_refs
  cleanup_eligible_refs
  debt_budget_by_action_class
  decision_by_action_class
  rollback_target
```

Each stage summary is explicit:

```text
terminal_stage_summary
  swarm
  stage
  last_success_at
  last_failure_at
  recent_terminal_count
  unsettled_count
  duplicate_attempt_count
  missing_artifact_count
  stale_after_ms
  confidence
  decision       # clear, observe, repair_only, hold_normal_dispatch, block_widen
```

Forecast reentry becomes a material action input:

```text
forecast_reentry_admission_product
  product_id
  generated_at
  source
  forecast_registry_status       # empty, probation, eligible, stale, contradicted
  eligible_model_refs
  tournament_refs
  empirical_job_refs
  clickhouse_freshness_refs
  torghut_signal_continuity_ref
  max_notional_by_stage
  required_repairs
  decision_by_stage              # observe, paper_canary, live_micro_canary, live_scale
```

Action class behavior:

- `dispatch_repair`: allowed when terminal debt exists and settlement evidence can be collected.
- `dispatch_normal`: held when unsettled terminal debt exceeds the window budget or artifact refs are missing.
- `deploy_widen`: held when terminal settlement confidence is low after a rollout or when controller readiness flaps
  exceed budget.
- `forecast_observe`: allowed with fresh signals and empirical jobs even when registry is empty.
- `forecast_paper_canary`: held until at least one probation model clears the Torghut forecast tournament.
- `forecast_live_micro_canary`: held until paper settlement, TCA, risk, and material action verdicts are green.
- `forecast_live_scale`: blocked until live micro proof and deployer approval exist.

## Implementation Scope

Engineer stage:

- Add a pure terminal settlement reducer under `services/jangar/src/server/`.
- Extend control-plane status with `terminal_run_settlement` in shadow mode.
- Add unit tests that feed retained `Completed` and `Error` pod/resource snapshots and assert action decisions.
- Add `forecast_reentry` to material action verdict inputs and tests.
- Add a bounded Torghut forecast product client that consumes the companion route/product without requiring Torghut DB
  privileges.

Deployer stage:

- Enable the route payload in shadow mode first.
- Compare settlement output against `kubectl get pods -n agents` phase counts for at least two schedule windows.
- Move to warn mode only after settlement counts match retained pod evidence within one terminal object.
- Move to enforce mode only after forecast observe products are fresh and paper/live forecast actions remain held while
  the registry is empty.

## Validation Gates

Required local checks:

- `bunx oxfmt --check docs/agents/designs/128-jangar-terminal-run-settlement-and-forecast-reentry-admission-2026-05-06.md`
- `bunx oxfmt --check docs/torghut/design-system/v6/132-torghut-forecast-profit-tournament-and-capital-reentry-guardrails-2026-05-06.md`
- Targeted Jangar tests for terminal settlement and material action verdict changes when code is implemented.
- Targeted Torghut tests for forecast tournament product validation when code is implemented.

Required runtime checks before enforcement:

- `kubectl get pods -n agents --no-headers | awk '{counts[$3]++} END {for (status in counts) print status, counts[status]}'`
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- `curl http://torghut.torghut.svc.cluster.local/trading/autonomy`
- ClickHouse freshness for `ta_microbars` and `ta_signals` max event timestamps.
- Jangar and Torghut migration-current checks through existing app status routes or read-only SQL.

Acceptance gates:

- Terminal settlement reports every retained Error pod as settled, cleanup-eligible, or repair-required.
- No normal dispatch is blocked solely by historical terminal pods older than the configured settlement horizon.
- Forecast observe remains allowed with fresh signals and empirical jobs.
- Forecast paper/live actions remain held while `forecast_registry_status=empty`.
- Forecast paper canary requires an eligible Torghut tournament product with measured edge and guardrail compliance.

## Rollout

1. Shadow mode: emit settlement and forecast reentry products without changing dispatch.
2. Warn mode: annotate status and NATS/Jangar updates when terminal debt or forecast registry state would hold an
   action.
3. Repair enforcement: allow `dispatch_repair` and cleanup after settlement, but hold normal dispatch only for fresh,
   unsettled debt.
4. Forecast observe enforcement: allow zero-notional tournaments when signals and empirical jobs are fresh.
5. Capital enforcement: require eligible tournament products before paper or live forecast capital.

## Rollback

- Disable terminal settlement enforcement with a feature flag and continue exposing the shadow payload.
- Disable forecast reentry enforcement and leave Torghut in observe-only mode.
- Keep Kubernetes TTL cleanup disabled unless settlement products are still emitted; do not delete terminal evidence
  before it is represented in a durable product.
- If the reducer over-blocks, revert to material action verdicts without `forecast_reentry` while preserving database,
  rollout, and watch reliability gates.

## Risks

- Terminal pod evidence can disappear before settlement if an external TTL controller is introduced first.
- A naive settlement reducer can over-count retries as independent failures.
- Forecast tournament products can become too broad and expensive if they do not bind to a specific hypothesis,
  account, symbol set, and time window.
- `registry_empty` should hold capital, not prevent zero-notional learning.

## Handoff Contract

Engineer:

- Implement the reducers as pure functions first.
- Keep all database checks bounded and index-backed.
- Add fixture tests for `37` Error pods plus a fresh healthy rollout, and for forecast registry empty with fresh
  ClickHouse signals.
- Do not require CNPG exec or privileged Kubernetes reads.

Deployer:

- Do not enforce until the route payload has matched read-only Kubernetes counts for two consecutive windows.
- Keep paper/live forecast capital at zero while `forecast_registry_status=empty`.
- Publish rollback evidence if terminal settlement blocks normal dispatch for old, already-settled pods.
