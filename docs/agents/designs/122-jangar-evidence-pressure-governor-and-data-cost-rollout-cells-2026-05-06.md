# 122. Jangar Evidence Pressure Governor And Data-Cost Rollout Cells (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, repair admission, rollout safety, database query pressure, Torghut profit
repair admission, and cross-swarm acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/126-torghut-hypothesis-custody-ledger-and-data-cost-profit-reserve-2026-05-06.md`

Extends:

- `121-jangar-material-action-repair-clearing-lane-and-profit-proof-ledger-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `105-jangar-evidence-pressure-runways-and-profit-proof-budgets-2026-05-06.md`

## Decision

I am selecting an **evidence pressure governor with data-cost rollout cells** as the next architecture step for the
Jangar control plane.

The current system is available but not quiet. At `2026-05-06T15:23Z`, the serving deployments were up:
`deployment/jangar` was `1/1`, `deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, the current
Torghut live and sim revisions were `1/1`, and the Jangar status route reported database, rollout, and watch health
as healthy. Jangar `/ready` later returned `status=ok` with serving passport
`passport:serving:bb7ae4404ff431b7`.

The same sample shows pressure the control plane should not ignore. Agents retained `36` failed pods, `32` failed
jobs, and `13` failed AgentRuns. Readiness warnings were still arriving on the current
`agents-controllers-7c6dfc8bf4` generation within the last minute of the sample. Torghut was serving, but recent
events showed startup/readiness churn on live/sim revisions, options catalog/enricher, `torghut-ws-options`, duplicate
ClickHouse PodDisruptionBudget matches, and Flink status-write conflicts. The database surface was fresh but costly:
Jangar had current `resources_current`, heartbeats, AgentRuns, and NATS message rows, while the same app database also
held about `50.8M` `torghut_control_plane.quant_pipeline_health` rows and about `1.86M` `quant_metrics_series` rows.

The previous material-action verdict and repair-clearing designs decide what is allowed and what can be repaired. They
do not decide whether the system is under enough pressure that repair, dispatch, rollout widening, and profit-proof
work should be throttled before the next failure becomes visible as an outage. This design adds that missing governor.

The tradeoff is that Jangar becomes more conservative during noisy-but-green windows. I accept that. The six-month
risk is not only that a controller goes down. It is that controller readiness flaps, failed schedule history, database
scan pressure, and Torghut data-plane churn are each treated as local facts until they combine into a rollout failure
or an unsafe capital decision.

## Runtime Objective And Success Metrics

This contract improves, maintains, and innovates the Jangar control plane by making pressure a first-class rollout and
repair input.

Success means:

- Jangar emits one pressure epoch per status window with bounded decisions for serving, controller witness, schedule
  dispatch, database query cost, repair clearing, and Torghut profit proof.
- A green deployment cannot widen rollout or dispatch broad repair while the pressure epoch reports recent readiness
  probe failures, failed job accumulation, or database query pressure above threshold.
- Database assessment and status routes use bounded projections and query budgets rather than ad hoc wide scans.
- Torghut profit repair is admitted only when Jangar pressure cells have spare repair capacity and the companion
  Torghut custody ledger agrees with runtime state.
- Engineer and deployer stages can validate the contract with pure reducer fixtures, route payload checks, and
  post-rollout gates.

## Evidence Snapshot

All production evidence was collected read-only with respect to Kubernetes resources and database records.

### Cluster And Rollout Evidence

- `kubectl config current-context` was unset, but Kubernetes reads worked under
  `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods were all `Running`: `8` running pods, including `jangar-7b6c986c76-g98bk`, `jangar-db-1`,
  OpenWebUI, Redis, Alloy, Bumba, and Symphony.
- Agents deployments were available: `agents=1/1` and `agents-controllers=2/2`.
- Agents pod phase counts were `Running=10`, `Succeeded=183`, and `Failed=36`.
- Agents job condition counts were `Complete=187`, `Failed=32`, and `Active=5`.
- Agents AgentRun phase counts were `Succeeded=155`, `Failed=13`, `Running=4`, and `Template=12`.
- Current agents warnings included readiness probe timeouts on both current controller pods
  `agents-controllers-7c6dfc8bf4-zsgkb` and `agents-controllers-7c6dfc8bf4-fp8qh`, plus an earlier
  `agents-smoke-cleanup-gbnrp` eviction for low node ephemeral storage.
- Torghut deploys and pods were mostly available, including current `torghut-00238`, `torghut-sim-00331`, live TA,
  sim TA, options TA, options catalog, options enricher, websocket pods, ClickHouse, Keeper, Postgres, guardrail
  exporters, Alloy, and Symphony.
- Recent Torghut warnings still showed startup/readiness failures on current and prior live/sim revisions, options
  catalog/enricher readiness churn, `torghut-ws-options` readiness `503`, duplicate ClickHouse PDB matches, and Flink
  status modification conflicts.
- The service account cannot list `statefulsets.apps` in `jangar`, `agents`, or `torghut`, cannot list CNPG clusters,
  and cannot create `pods/exec` into CNPG database pods. The pressure design must therefore use service-owned
  projections and explicitly granted read surfaces instead of privileged cluster assumptions.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `753` lines and already composes database health, rollout
  health, watch reliability, workflow freshness, empirical services, execution trust, runtime admission, failure-domain
  leases, action clocks, negative evidence, and controller witness inputs.
- `services/jangar/src/server/control-plane-controller-witness.ts` is `423` lines and models controller ingestion
  unknown/stalled states as material-action downgrades.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and maps stale empirical jobs,
  controller-ingestion gaps, rollout ambiguity, workflow failures, and data freshness debt into action SLO budgets.
- `services/jangar/src/server/control-plane-action-clock.ts` is `276` lines and translates proof debt into material
  action clocks.
- `services/jangar/src/server/control-plane-watch-reliability.ts` is `181` lines and already provides a windowed watch
  reliability summary.
- `services/jangar/src/server/supporting-primitives-controller.ts` is `2883` lines and remains the high-risk runtime
  owner for schedules, runner ConfigMaps, CronJobs, workspace state, PVC lifecycle, requirements, freezes, and swarm
  admission.
- `services/jangar/src/server/primitives-kube.ts` is `690` lines and now includes PVC support, reducing the older PVC
  primitive gap.
- Focused tests exist for status, controller witness, action clocks, negative evidence, watch reliability,
  failure-domain leases, runtime admission, primitives, and supporting schedules. The missing regression surface is
  cross-pressure behavior: a green rollout plus current readiness flaps and failed job debt must not look equivalent to
  a quiet green rollout.

### Database And Data Evidence

- Direct Jangar SQL used the CNPG app secret from `jangar-db-app`; `current_database=jangar`, `current_user=jangar`,
  and `pg_is_in_recovery=false`.
- Direct Torghut SQL used `torghut-db-app`; `current_database=torghut`, `current_user=torghut_app`, and
  `pg_is_in_recovery=false`.
- Jangar database projection was fresh:
  - `agents_control_plane.resources_current` had `3448` rows with `max(last_seen_at)=2026-05-06T15:28:41.312Z`;
  - `agents_control_plane.component_heartbeats` had `4` rows with `max(observed_at)=2026-05-06T15:28:32.178Z`;
  - `public.agent_runs` had `384` rows with `max(updated_at)=2026-05-06T15:28:41.314Z`;
  - `workflow_comms.agent_messages` had `7362` rows with `max(created_at)=2026-05-06T15:28:17.561Z`;
  - latest Jangar Kysely migration was `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar table statistics also show a pressure source:
  - `torghut_control_plane.quant_pipeline_health` estimated `50814405` live rows;
  - `torghut_control_plane.quant_metrics_series` estimated `1857996` live rows;
  - `torghut_control_plane.quant_metrics_latest` estimated `3780` live rows and had a fresh autoanalyze.
- Torghut Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- Torghut exact counts showed `147606` `trade_decisions` with `max(created_at)=2026-05-04T17:25:57.901Z` and `13778`
  `executions` with `max(created_at)=2026-04-02T20:59:45.104Z`.
- Torghut governance tables were structurally present but not populated for the active capital path:
  `strategy_hypotheses=0`, `strategy_hypothesis_metric_windows=0`, `strategy_promotion_decisions=0`,
  `autoresearch_epochs=0`, while `vnext_empirical_job_runs=16`.
- Torghut options tables were active and large: `torghut_options_contract_catalog` estimated `2388490` rows,
  `torghut_options_subscription_state` estimated `6028` rows, and small freshness checks showed options ranking and
  watermarks updated around `2026-05-06T15:27Z` to `15:28Z`.
- Torghut PostgreSQL statistics for `trade_decisions` and `executions` had `n_live_tup=0` and no analyze timestamps
  even though exact bounded counts proved nonzero rows. That is a schema-quality signal: capital gates should not rely
  on stale catalog statistics for proof availability.

### Runtime API Evidence

- Jangar control-plane status reported `database.status=healthy`, migration consistency healthy at `28/28`,
  `rollout_health=healthy`, `watch_reliability=healthy`, dependency quorum `block`, AgentRun ingestion `unknown`, and
  negative evidence router `observe`.
- Jangar action SLO budgets allowed `serve_readonly` and `dispatch_repair`, set `dispatch_normal=repair_only`, held
  `merge_ready` and `paper_canary`, and blocked `live_micro_canary` and `live_scale`.
- Torghut `/healthz` returned `{"status":"ok","service":"torghut"}`.
- Torghut `/trading/health` returned `status=degraded`. Postgres, ClickHouse, Alpaca, and universe were healthy, but
  live submission was blocked by `simple_submit_disabled`, capital stage was `shadow`, empirical jobs were degraded
  with authority `blocked`, and typed quant health was not configured.
- Torghut `/trading/status` reported `mode=live`, `running=true`, `last_decision_at=2026-05-04T17:25:57.901670Z`,
  `last_run_at=2026-05-06T15:30:10.932263Z`, and live submission blocked with `promotion_eligible_total=0`.
- Torghut empirical jobs were `ready=false`, `status=degraded`, `authority=blocked`, and contained four stale completed
  jobs from `2026-03-21T09:03:22.150009Z` for candidate `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.

## Problem

Jangar currently has good point-in-time health and increasingly strong decision surfaces. It still needs a governor
that interprets system pressure before a material action is admitted.

Three failure modes are visible now:

1. **Availability can be green while rollout pressure is high.** Controller pods are ready overall, but current
   readiness warnings and failed job debt show the control plane is still absorbing churn.
2. **Database freshness can hide query pressure.** The Jangar projection is current, but some proof tables are large
   enough that naive status or assessment queries become operationally risky.
3. **Torghut profit work can compete with control-plane repair.** Stale empirical jobs and shadow capital are real
   profit blockers, but they should not spend repair capacity while controller witness or schedule pressure is high.

Without a pressure governor, engineers can implement the repair-clearing lane correctly and still admit too much work
during a noisy green window.

## Alternatives Considered

### Option A: Keep Pressure As Human Interpretation

Operators read pod failures, readiness events, database stats, and Torghut status manually before allowing rollout or
repair work.

Pros:

- No new runtime surface.
- Preserves the recent verdict and repair-clearing contracts unchanged.
- Fastest short-term path.

Cons:

- Automated consumers cannot reason about pressure.
- A green rollout can be mistaken for a quiet rollout.
- Every deployer must rediscover the same failed-job and database-pressure signals.
- Torghut repair admission still lacks a shared capacity budget.

Decision: reject. The current evidence is exactly the kind of noisy green state humans will interpret inconsistently.

### Option B: Split Jangar And Torghut Pressure Management

Jangar governs controller and rollout pressure. Torghut independently governs trading proof pressure and submits only
when its local budget allows.

Pros:

- Keeps domain logic local.
- Lets Torghut move faster on profit experiments.
- Avoids one cross-plane reducer.

Cons:

- Recreates local Torghut authority for work that consumes Jangar dispatch capacity.
- Cannot compare controller witness repair against profit-proof repair.
- Does not solve database pressure shared across status and proof projections.
- Makes rollback harder because pressure is distributed across two owners.

Decision: reject as the primary authority. Torghut should publish data-cost and profit-reserve facts, but Jangar should
admit cross-plane repair capacity.

### Option C: Evidence Pressure Governor And Data-Cost Rollout Cells

Jangar emits a pressure epoch that consumes rollout health, readiness event pressure, failed job debt, watch
reliability, database query cost, controller witness state, repair-clearing demand, and Torghut profit/data-cost bids.
Material action verdicts and repair-clearing decisions remain authoritative, but pressure cells decide whether the
system can spend capacity now.

Pros:

- Makes noisy green windows visible to automation.
- Adds a common budget for controller repair and Torghut profit repair.
- Prevents database-heavy proof reads from becoming status-path incidents.
- Gives deployers one rollback lever: disable pressure enforcement while keeping shadow emission.
- Preserves recent verdict and clearing lane designs as inputs.

Cons:

- Adds one more reducer and status projection.
- Requires careful thresholds so stale failed pod history does not permanently freeze progress.
- Needs Torghut to publish reliable data-cost facts instead of optimistic profit-only bids.

Decision: select Option C.

## Architecture

Jangar adds a `control_plane_pressure_epoch` projection.

```text
control_plane_pressure_epoch
  epoch_id
  generated_at
  expires_at
  namespace
  producer_revision
  rollout_health_ref
  watch_reliability_ref
  controller_witness_ref
  negative_evidence_ref
  material_action_verdict_ref
  repair_clearing_ref
  database_projection_ref
  torghut_profit_reserve_refs
  global_pressure_decision          # allow, watch, throttle, repair_only, block
  cells
```

Each cell is scoped and budgeted.

```text
pressure_cell
  cell_id
  cell_class                        # serving, controller_witness, schedule_dispatch, database_query,
                                    # repair_clearing, torghut_profit_proof, rollout_widen
  pressure_score                    # 0-100
  decision                          # allow, watch, throttle, repair_only, block
  reason_codes
  evidence_refs
  max_new_dispatches
  max_parallel_repairs
  max_query_cost_units
  max_runtime_seconds
  freshness_budget_seconds
  clears_after
  rollback_target
```

The first implementation is a pure reducer. It must not add collector logic to
`supporting-primitives-controller.ts`.

## Reducer Rules

1. Serving stays `allow` when routes and database are healthy, even if other cells throttle.
2. Controller witness pressure becomes `repair_only` when current readiness events, stale ingestion, or split witness
   evidence appear in the same window.
3. Schedule dispatch becomes `throttle` when failed jobs or failed pods exceed the configured per-window budget.
4. Rollout widening becomes `watch` or `throttle` when current-generation readiness warnings occur after a rollout
   appears available.
5. Database query pressure becomes `throttle` when a status input would require unbounded scans, stale statistics, or
   tables above the configured row-count band. The status path must use materialized projections or bounded samples.
6. Torghut profit-proof repair can only be admitted when controller witness and schedule dispatch cells are no worse
   than `throttle`, database query pressure has spare cost units, and the companion Torghut custody ledger is current.
7. Live capital remains `block` unless the material-action verdict, pressure epoch, Torghut local gate, empirical
   proof, quant proof, execution realism, and hypothesis custody ledger all agree.

## Implementation Scope

Engineer stage:

1. Add `services/jangar/src/server/control-plane-pressure-governor.ts` as a pure reducer.
2. Feed it from existing control-plane status inputs: rollout health, watch reliability, controller witness,
   AgentRun ingestion, workflows reliability, action SLO budgets, repair-clearing demand, database status, and Torghut
   profit reserve input.
3. Add `control_plane_pressure_epoch` to `/api/agents/control-plane/status`.
4. Add a small data-cost input contract for Torghut so the Jangar reducer sees options catalog size, freshness,
   empirical-job freshness, and custody-ledger parity without scanning Torghut tables.
5. Add tests for:
   - green rollout plus current readiness warnings produces `rollout_widen=watch` and
     `controller_witness=repair_only`;
   - failed job debt throttles schedule dispatch but keeps `serve_readonly=allow`;
   - large table or stale stats inputs reduce `database_query` budget;
   - Torghut profit proof is held when custody ledger parity is missing or database query budget is exhausted;
   - pressure enforcement can be disabled while shadow projection remains stable.

Deployer stage:

1. Roll out pressure epochs in `shadow`.
2. Observe one full Jangar scheduling cycle and confirm pressure cells match cluster and database evidence.
3. Enforce controller witness and schedule dispatch pressure before Torghut profit-proof pressure.
4. Keep live capital pressure enforcement blocked until the companion Torghut custody ledger is populated and current.

## Validation Gates

Local validation before merge:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-pressure-governor.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bun run --cwd services/jangar check:module-sizes`
- `bun run --cwd services/jangar lint`

Runtime validation after rollout:

- `/api/agents/control-plane/status?namespace=agents` includes `control_plane_pressure_epoch`.
- In the current readiness-flap sample, `serve_readonly=allow`, `controller_witness=repair_only`, and
  `rollout_widen` is not greener than `watch`.
- In the current agents failed-job sample, broad schedule dispatch is throttled while one bounded controller repair can
  remain admitted.
- Database pressure identifies large or stale-stat proof surfaces without issuing unbounded scans from the status
  route.
- Torghut paper/live repair is not admitted until the companion custody ledger and data-cost reserve are current.

## Rollout Plan

1. Shadow emit pressure epochs and compare against existing material-action verdicts for one scheduling cycle.
2. Add UI and deployer output that labels pressure as capacity control, not action authority.
3. Enforce controller witness and schedule dispatch pressure for repair admission.
4. Enforce database query pressure for status and proof paths by replacing wide reads with materialized or bounded
   projections.
5. Enforce Torghut profit-proof pressure only after the companion contract ships.

## Rollback Plan

- If pressure epoch generation fails, disable pressure enforcement and keep existing material-action verdicts.
- If pressure cells are too conservative, keep shadow emission and lower enforcement to `watch`.
- If pressure cells are too permissive, force `global_pressure_decision=block` for rollout widening and profit repair,
  then revert the reducer PR.
- If the Torghut data-cost input is malformed, ignore it and keep Torghut repair at `hold`; do not promote capital.
- Additive persistence can remain during incident rollback. Do not drop database tables as a rollback step.

## Risks

- Failed pod history can overstate current risk. The reducer needs time windows and decay, not lifetime totals.
- Database cost units can become hand-wavy unless the first implementation records source table class, row band,
  freshness, and timeout behavior.
- Torghut profit bids can crowd out platform repair. Action-class budgets must reserve controller witness capacity.
- The app database user is not a safe long-term inspection role. Repeated data assessment should use a dedicated
  read-only role with statement timeout and application name.

## Handoff

Engineer acceptance gates:

- A fixture matching the current state, with available deployments and current readiness warnings, emits
  `serve_readonly=allow`, `controller_witness=repair_only`, `schedule_dispatch=throttle`, and
  `rollout_widen=watch`.
- A fixture with fresh projections but large proof tables emits a finite `database_query` budget and never requires a
  wide table scan.
- A fixture with Torghut stale empirical jobs and missing custody-ledger parity holds profit-proof repair.
- Status tests prove pressure epochs cite material-action verdict and repair-clearing refs without replacing either.

Deployer acceptance gates:

- Shadow pressure epochs are stable for one full Jangar scheduling cycle.
- Enforcing controller pressure does not break `/ready` or read-only Jangar routes.
- Schedule dispatch throttling reduces new broad work while allowing one bounded controller witness repair.
- Torghut paper/live capital remains shadow-only until local gates, custody parity, Jangar verdict, and pressure epoch
  all agree.
