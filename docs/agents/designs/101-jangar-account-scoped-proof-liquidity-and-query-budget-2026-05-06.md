# 101. Jangar Account-Scoped Proof Liquidity And Query Budget (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, Torghut quant proof projection, query-budgeted status routes, account-scoped
capital authority, and rollout admission.

Companion Torghut contract:

- `docs/torghut/design-system/v6/105-torghut-account-scoped-hypothesis-liquidity-and-options-bootstrap-2026-05-06.md`

Extends:

- `100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`
- `99-jangar-evidence-lease-cells-and-rollout-admission-arbiter-2026-05-06.md`
- `92-jangar-torghut-proof-feed-route-budget-and-quorum-split-2026-05-05.md`
- `86-jangar-query-budgeted-evidence-receipts-and-admission-firebreaks-2026-05-05.md`

## Decision

I am choosing an **account-scoped proof liquidity router** for Jangar.

Jangar is healthier than the previous shared soak suggested. The current `/ready` and control-plane status routes report
healthy execution trust, healthy runtime kits including `nats`, configured workflow and job runtimes, healthy watch
reliability, healthy database connectivity, and current Kysely migrations. That is real progress.

The remaining failure mode is more precise: Jangar can have fresh generic quant metrics while the live Torghut account
is stale or missing. At `2026-05-06T04:15Z`, `torghut_control_plane.quant_metrics_latest` had 3,780 latest rows, but
the generic account had fresh windows at `2026-05-06T04:15Z` while the live account `PA3SX7FYNUTF` last updated around
`2026-05-05T19:13Z`. The route
`/api/torghut/trading/control-plane/quant/health?account=paper&window=1d` returned HTTP 200 with
`latestMetricsCount=0` and `emptyLatestStoreAlarm=true`. Torghut live reports quant health is not configured for its
actual account. That mismatch is the architecture problem.

The selected design makes proof liquidity account/window specific. Generic proof can fund observe-only dashboards and
repair scheduling. It cannot fund Torghut paper/live capital, merge-ready claims, or rollout widening for trading
workloads. Jangar also needs to stop using unbounded scans on very large projection tables as a live authority path:
`quant_metrics_series` is estimated at roughly 314 million rows and `quant_pipeline_health` at roughly 50 million rows;
read-only `count(*)` and a latest-stage sample timed out under a five second statement timeout. The control plane needs
a compact, current proof-liquidity projection with fixed query cost.

The tradeoff is stricter admission. Some Jangar routes will look green while Torghut capital remains held. I accept
that. Green platform health says the control plane can operate; it does not say a specific trading account has fresh
profit proof.

## Read-Only Evidence Snapshot

No Kubernetes resources or database records were mutated. Database access used application services and direct
service connections with read-only transactions because CNPG pod exec is forbidden for this runtime identity.

### Cluster And Rollout Evidence

- The runtime Kubernetes identity is `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was initially unset, then an `in-cluster` context was configured from the service
  account token and verified with `kubectl auth whoami`.
- `kubectl get pods -n jangar -o wide` showed `jangar-d75944dff-4msq2` at `2/2 Running`, `jangar-db-1` at
  `1/1 Running`, and all Jangar application pods running.
- `kubectl get deployments -n jangar -o wide` showed `deployment/jangar` at `1/1` on image
  `registry.ide-newton.ts.net/lab/jangar:0bba2aa8`.
- `kubectl get pods -n agents -o wide` showed `agents`, both `agents-controllers` replicas, and `agents-alloy`
  running. Recent events still included readiness probe deadline warnings on `agents` and `agents-controllers`, but the
  current deployments were available.
- `kubectl get deployments,cronjobs,jobs -n agents -o wide` showed hourly Jangar and Torghut swarm CronJobs active, with
  recent current-image jobs completing. Historical failed verify/discover jobs remain visible and must be interpreted
  inside a bounded stage window.
- `kubectl get pods -n torghut -o wide` showed Torghut live revision `torghut-00228` and simulation revision
  `torghut-sim-00309` at `2/2 Running`, plus ClickHouse, Postgres, options, TA, websocket, and guardrail exporter pods
  running.

### Jangar Status Evidence

- `GET /ready` returned HTTP 200 with `status=ok`, leader election healthy, execution trust healthy, memory provider
  healthy, and runtime kits healthy for serving and collaboration.
- `GET /api/agents/control-plane/status?namespace=agents` returned a payload generated at
  `2026-05-06T04:10:10.587Z`.
- Controllers were healthy through heartbeat authority for agents, supporting, and orchestration controllers.
- Workflow and job runtimes were `configured`; Temporal configuration was resolved at
  `temporal-frontend.temporal.svc.cluster.local:7233`.
- Database status was healthy with 28 registered and 28 applied Kysely migrations, latest
  `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was healthy over the 15 minute window, with 8,704 AgentRun events, zero errors, and zero AgentRun
  stream restarts.
- The one weak point in the same payload is still semantic, not availability: `agentrun_ingestion.status` was
  `unknown` with message `agents controller not started` in the Jangar serving view while the controller heartbeat view
  was healthy. Reconciled action decisions must name which authority they are using.

### Torghut Consumer Evidence

- Jangar quant health for `account=paper&window=1d` returned HTTP 200 but `status=degraded`, `latestMetricsCount=0`,
  `latestMetricsUpdatedAt=null`, and `emptyLatestStoreAlarm=true`.
- Torghut live `/trading/status` returned HTTP 200 on revision `torghut-00228`, commit
  `d7521779328d92f1a2b90b5774c7d331448f7f6c`, with `mode=live`, `execution_lane=simple`,
  `capital_stage=shadow`, and `live_submission_gate.allowed=false` because `simple_submit_disabled`.
- Torghut live `/readyz` returned HTTP 503. Scheduler, Postgres, ClickHouse, Alpaca, and schema checks were OK, but
  universe had zero symbols, empirical jobs were degraded, live submission was blocked, and alpha readiness had three
  hypotheses, zero promotion-eligible hypotheses, and three rollback-required hypotheses.
- Torghut live `/trading/empirical-jobs` returned HTTP 200 with `authority=blocked` and stale jobs
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`, all created
  `2026-03-21T09:03:22Z`.
- Torghut simulation `/readyz` and `/trading/health` returned HTTP 200, but simulation quant evidence remained
  degraded for `TORGHUT_SIM` with `quant_latest_metrics_empty`, `quant_latest_store_alarm`, and
  `quant_pipeline_stages_missing`.
- Options catalog and enricher `/readyz` returned HTTP 200; the database still showed options feature ClickHouse
  tables empty.

### Database And Data Evidence

- Direct `kubectl cnpg psql` was forbidden in `jangar` and `torghut` because this service account cannot create
  `pods/exec`. Secret reads are allowed, so service-level connections were used with read-only Postgres transactions.
- Torghut Postgres had 71 public tables and Alembic head `0029_whitepaper_embedding_dimension_4096`.
- `execution_order_events` had zero rows, while `execution_tca_metrics` had 13,775 rows with latest update
  `2026-04-03T05:32:36Z`. That means TCA history exists, but broker-event reconciliation is not yet live.
- `vnext_empirical_job_runs` had 16 rows, latest update `2026-03-21T09:03:22Z`.
- Jangar Postgres had 54 public tables and Kysely latest migrations through
  `20260505_torghut_quant_pipeline_health_window_index`.
- In Jangar `torghut_control_plane`, `quant_metrics_latest` had 3,780 rows. Generic account windows were fresh at
  `2026-05-06T04:15Z`; live account `PA3SX7FYNUTF` windows were stale from `2026-05-05T17:26Z` through
  `2026-05-05T19:13Z`.
- `quant_metrics_series` is estimated at 314,034,592 rows and `quant_pipeline_health` at 50,690,392 rows. Direct count
  or distinct-latest sampling timed out under a five second statement timeout.
- ClickHouse `torghut.ta_microbars` had 1,676,707 rows with max event time `2026-05-05T20:59:07Z`; `torghut.ta_signals`
  had 1,176,729 rows with max event time `2026-05-05T20:59:07Z`.
- ClickHouse options tables `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features`
  had zero rows.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes controller, runtime, rollout, database, watch,
  workflow, empirical-service, failure-domain, execution-trust, and Torghut proof data.
- `services/jangar/src/server/torghut-quant-runtime.ts` is 817 lines, `torghut-quant-metrics.ts` is 928 lines, and
  `torghut-quant-metrics-store.ts` is 399 lines. The code already has a quant runtime and store, but the live authority
  path still exposes account/window ambiguity and huge-table pressure.
- Jangar has focused tests for quant health, snapshot, series, alerts, runtime materialization, metrics store, runtime
  admission, execution trust, and control-plane status. The missing test surface is account-scoped capital authority:
  generic fresh metrics must not satisfy live account proof, and query timeouts in large historical tables must not make
  status unavailable.

## Problem

Jangar has improved platform reliability, but proof authority is still too broad.

1. Generic account metrics can be fresh while the live account proof is stale.
2. A route can return HTTP 200 with degraded proof and still be misread by downstream actors as permission to proceed.
3. Massive historical projection tables sit behind control-plane routes, creating latency and timeout risk.
4. Torghut capital needs account/window-specific proof, but current Jangar route health mostly answers whether the
   control plane is alive.
5. Deployer and engineer stages need a compact action decision that works under least-privilege RBAC without CNPG exec.

The failure mode is not "Jangar is down." The failure mode is "Jangar is up and returns a proof answer for the wrong
account, or an unbounded query path turns capital authority into a timeout."

## Alternatives Considered

### Option A: Treat Generic Fresh Metrics As A Fallback

This option lets fresh `account=''` metrics satisfy live-account proof if the account-specific row is missing or stale.

Pros:

- Maximizes route availability.
- Gives dashboards a current-looking answer.
- Requires little new code.

Cons:

- It conflates generic observation with account-specific capital authority.
- It can green-light paper/live decisions for an account whose proof is stale.
- It hides the exact repair lane Torghut needs.

Decision: reject. Generic metrics are useful for observe-only and repair triage, not capital authority.

### Option B: Query Historical Tables Directly On Demand

This option keeps the current tables and adds indexes or larger timeouts.

Pros:

- Avoids another projection.
- Maintains full traceability in one data store.
- Can work for analyst queries.

Cons:

- It makes Jangar status depend on tables with hundreds of millions of rows.
- It is fragile under RBAC-limited deployer checks and hot-path health calls.
- Bigger timeouts improve analyst convenience while degrading control-plane reliability.

Decision: reject for live authority. Keep historical tables for audit and analysis.

### Option C: Account-Scoped Proof Liquidity Router

This option materializes compact proof liquidity per account, window, hypothesis family, and action class. Historical
tables remain audit sources. The hot path reads only the compact projection.

Pros:

- Separates observe, repair, paper, and live authority.
- Makes account/window mismatch an explicit blocker.
- Keeps Jangar status within fixed query budgets.
- Gives Torghut a single proof-liquidity ref to cite in broker and scheduler decisions.
- Supports safer rollout because deploy widening can require a fresh proof-liquidity sample for trading workloads.

Cons:

- Adds one projection and reducer.
- Needs careful shadow-mode comparison against existing routes.
- Requires Torghut to publish account identity consistently.

Decision: select Option C.

## Chosen Architecture

### ProofLiquidityRecord

Jangar should project one current record per account, window, subject, and action class:

```text
proof_liquidity_record
  record_id
  subject_kind              # quant_metrics, empirical_jobs, broker_events, options_features, universe
  subject_ref               # stable account/window/hypothesis/dataset ref
  account
  window
  hypothesis_id
  action_class              # observe, repair, paper_capital, live_capital, deploy_widen, merge_ready
  liquidity_state           # liquid, thin, stale, missing, contradictory, blocked
  authority_scope           # generic, account_scoped, hypothesis_scoped, broker_scoped
  latest_observed_at
  fresh_until
  source_table
  source_watermark
  source_count_hint
  blocking_reason_codes[]
  repair_lane
  artifact_refs[]
  producer_revision
```

### Query Budget Rules

- `/ready` must not query `quant_metrics_series` or `quant_pipeline_health`.
- Control-plane status may expose historical estimates but must compute action decisions from compact current records.
- Any query used by `torghut_capital`, `deploy_widen`, or `merge_ready` must have a bounded index path and a p95 under
  750 ms in-cluster.
- If the compact projection is missing, the decision is `missing`, not an on-demand scan of historical tables.
- Generic `account=''` records can only emit `action_class=observe` or `action_class=repair`.

### Reducer Rules

For the current evidence, Jangar should emit:

- Generic fresh quant metrics: `liquidity_state=liquid`, `authority_scope=generic`, `action_class=observe`.
- Live account `PA3SX7FYNUTF` quant metrics older than the freshness budget: `liquidity_state=stale`,
  `action_class=paper_capital/live_capital`, `repair_lane=quant_metrics_rebuild`.
- Stale empirical jobs from March 21: `liquidity_state=stale`, `repair_lane=empirical_replay`.
- Empty options features: `liquidity_state=missing`, `repair_lane=options_feature_bootstrap`.
- Empty broker event reconciliation: `liquidity_state=missing`, `repair_lane=broker_event_reconcile`.
- Healthy platform runtime and runtimes: `liquidity_state=liquid` for `dispatch_repair`, not for capital.

### Failure-Mode Reduction

This design removes four concrete failure modes:

- **Wrong-scope proof:** generic metrics cannot satisfy live-account capital proof.
- **Route timeout authority:** historical table scans cannot sit on admission decisions.
- **Green route overread:** HTTP 200 degraded proof carries explicit action classes.
- **Invisible repair debt:** missing options features, stale empirical jobs, and empty broker events become named repair
  lanes.

## Implementation Scope

Engineer stage should land this in small slices:

1. Add a pure reducer under `services/jangar/src/server/control-plane-proof-liquidity.ts`.
2. Add a compact `torghut_control_plane.proof_liquidity_current` table or equivalent cache. The first version can be
   additive and shadow-only.
3. Populate the projection from existing latest quant metrics, empirical service status, Torghut route payloads, and
   broker-event watermarks.
4. Extend control-plane status with `proof_liquidity` and `action_liquidity_decisions`, while preserving existing
   fields for compatibility.
5. Update Torghut quant health routes to return account/window mismatch and source account explicitly.
6. Add tests proving generic metrics do not satisfy account-scoped capital, stale live-account metrics block capital,
   and historical table query failures do not make `/ready` or status unavailable.

## Validation Gates

- Unit tests: reducer fixtures for generic fresh metrics, live-account stale metrics, missing metrics, empty options
  features, stale empirical jobs, and empty broker events.
- Route tests: `/api/torghut/trading/control-plane/quant/health` returns account/window proof scope and action class
  decisions.
- Store tests: compact projection reads do not touch `quant_metrics_series` or `quant_pipeline_health` in hot paths.
- Integration smoke: `GET /ready` and control-plane status remain under 750 ms p95 while historical table counts are
  deliberately timing out in test doubles.
- Least-privilege validation: deployer can validate proof liquidity through Jangar routes without `pods/exec` or secret
  reads.

## Rollout

1. Ship the projection in shadow mode and log mismatches between existing quant-health status and proof-liquidity
   decisions.
2. Expose `proof_liquidity` in control-plane status for observe-only consumers.
3. Require proof-liquidity records for `torghut_capital` while leaving repair lanes open.
4. Require proof-liquidity records for trading workload `deploy_widen` and `merge_ready`.
5. Let Torghut cite proof-liquidity record ids in its hypothesis liquidity book and broker admission path.

## Rollback

- Disable consumption of proof-liquidity decisions while keeping projection writes for forensic comparison.
- Keep generic metrics observe-only even during rollback.
- If projection freshness fails, hold `torghut_capital` and allow `dispatch_repair`.
- Do not delete historical projection or liquidity rows; they are the audit trail for why capital was held.

## Risks

- The first projection could be too strict and hold paper capital longer than needed. That is acceptable in shadow and
  repair stages.
- Account identity must be normalized across Torghut, Jangar, Alpaca, and simulation; otherwise the system will create
  false missing-proof states.
- Historical table compaction must not erase lineage. Compact rows need source watermarks and artifact refs.
- Engineers may be tempted to treat options service readiness as options proof. Empty options feature tables must remain
  capital-blocking until data exists.

## Handoff

Engineer acceptance gate: Jangar emits compact account/window proof-liquidity records; generic metrics cannot authorize
paper/live capital; status routes stay responsive without scanning historical quant tables; and tests cover account
scope, query timeout, stale empirical jobs, empty options features, and empty broker events.

Deployer acceptance gate: with the current cluster state, `torghut_capital` remains held for `PA3SX7FYNUTF` because
live-account metrics are stale, empirical jobs are stale, options features are empty, and broker events are empty. The
deployer can verify this through Jangar and Torghut projected routes without privileged database exec.
