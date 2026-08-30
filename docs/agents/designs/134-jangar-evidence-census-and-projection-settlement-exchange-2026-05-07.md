# 134. Jangar Evidence Census And Projection Settlement Exchange (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, rollout safety, projection quality, controller heartbeats, database freshness,
event processing, schedule outcomes, Torghut capital handoff, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/138-torghut-profit-stats-census-and-tca-reactivation-market-2026-05-07.md`

Extends:

- `133-jangar-in-flight-stage-renewal-bonds-and-controller-ingestion-settlement-2026-05-07.md`
- `132-jangar-renewable-passport-ledger-and-proof-floor-actuation-2026-05-07.md`
- `126-jangar-projection-witness-exchange-and-material-evidence-products-2026-05-06.md`
- `87-jangar-database-pressure-fuses-and-capital-authority-backplane-2026-05-05.md`

## Decision

I am selecting **evidence census with projection settlement exchange** as the next Jangar control-plane architecture
step.

The previous contract made in-flight stage renewal visible. The current run shows the next reliability gap is not
whether Jangar can launch or observe work. It can. At `2026-05-07T06:29Z`, Jangar serving pods, Agents controllers,
and Torghut live and simulation deployments were running current image `6315e298`. Current schedules were firing, and
recent Jangar and Torghut cron jobs completed. The risk is that each surface can look locally healthy while the control
plane still lacks one settled answer about the quality of the evidence it is about to trust.

The evidence is specific. The Agents namespace still carried `57` Error pods and `17` failed Jobs alongside current
running controllers and completed schedule work. Jangar database projections were fresh, but
`agents_control_plane.component_heartbeats` reported `agents-controller:disabled`, `supporting-controller:disabled`,
and `workflow-runtime:disabled` while Kubernetes deployments were healthy. `agents_control_plane.resources_current`
held `3519` rows with `3225` deleted rows, so cache hygiene and live object truth need an explicit reconciliation
receipt. `jangar_github.events` held `61583` rows with `61583` unprocessed rows. Torghut was Healthy but OutOfSync in
Argo CD for analysis templates, workflow templates, and Services. Torghut database statistics were stale enough that
`pg_stat_user_tables` estimated `trade_decisions` at `17` rows while the actual count was `147623`.

I am not selecting another local retry, TTL increase, or route-specific gate. The chosen design creates a single census
that classifies every material projection as `current`, `stale`, `unprocessed`, `disabled`, `drifted`,
`stats_stale`, `out_of_sync`, or `blocked`, then emits settlement receipts that material action gates and deployer
checks can consume. The tradeoff is one more control-plane reducer and one more route payload. I accept that tradeoff
because the current failure modes are cross-surface failures. They will not be reduced by improving one surface at a
time.

## Runtime Objective And Success Metrics

This contract increases resilience by making projection quality explicit before Jangar allows deploy widening, normal
dispatch, merge-ready claims, or Torghut paper capital.

Success means:

- A rollout is not considered settled when Kubernetes is healthy but Argo CD is OutOfSync on material resources.
- A controller lane is not considered authoritative when deployment availability and database heartbeat status disagree.
- A read model is not considered clean when the deleted-row ratio, last-seen age, or source watch freshness breaches
  its budget.
- Event sinks with unprocessed backlogs are visible as raw evidence debt, not silently treated as useful proof.
- Database planner statistics on material tables have a freshness and cardinality-drift verdict.
- Material action verdicts carry projection receipt ids and reason codes, not just local readiness booleans.
- Deployer and engineer stages can validate the contract with read-only route, Kubernetes, and SQL checks.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps state, broker state,
trading flags, or AgentRun records.

### Cluster, Rollout, And Event Evidence

- `jangar` namespace was fully running: `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`, Redis, Open WebUI,
  `symphony`, and `symphony-jangar` were Running.
- `deployment/jangar`, `deployment/bumba`, `deployment/jangar-alloy`, `deployment/symphony`, and
  `deployment/symphony-jangar` were `1/1` available.
- `agents` namespace had current serving and controller deployments available:
  `deployment/agents=1/1`, `deployment/agents-controllers=2/2`, and `deployment/agents-alloy=1/1`.
- Historical workload debt remained high: `agents` had `170` Completed pods, `57` Error pods, and `17` failed Jobs.
- Current schedules existed for `jangar-control-plane-{discover,plan,implement,verify}` and
  `torghut-quant-{discover,plan,implement,verify}` with active cron intervals.
- Current schedule Jobs completed in the observed window, including Jangar plan and Torghut plan schedule runs.
- Recent events still included controller and serving readiness probe timeouts during rollout, followed by successful
  starts on image `6315e298`.
- Torghut live and simulation deployments were available, but Argo CD reported the `torghut` Application OutOfSync on
  `AnalysisTemplate`, `WorkflowTemplate`, and `Service` resources while health remained Healthy.
- Torghut events included repeated `MultiplePodDisruptionBudgets` warnings for ClickHouse pods and `NoPods` for a
  keeper PDB, which should affect rollout confidence even when pods are currently Running.

### Database And Projection Evidence

- Jangar PostgreSQL was reachable through its service secret and reported current time during read-only SQL checks.
- `agents_control_plane.resources_current` had `3519` rows, max `updated_at` and `last_seen_at` at
  `2026-05-07T06:29:34.450Z`, and `3225` rows with `deleted_at` set.
- `AgentRun` dominated the resource projection with `3480` rows and current `last_seen_at`; `ImplementationSpec`,
  `Agent`, `AgentProvider`, and `VersionControlProvider` projections were present but much smaller.
- `agents_control_plane.component_heartbeats` had only `4` rows. Its freshest heartbeat was
  `2026-05-07T06:29:30.479Z`, but component states were `agents-controller:disabled`,
  `orchestration-controller:healthy`, `supporting-controller:disabled`, and `workflow-runtime:disabled`.
- `public.agent_runs` reported `282` Succeeded, `145` Failed, and `28` Running rows, with fresh updates across current
  work.
- `workflow_comms.agent_messages` was current through `2026-05-07T06:28:51.180Z` with `6784` `general` messages and
  `2476` `run` messages.
- `jangar_github.events` contained `61583` rows, max received at `2026-05-07T06:29:10.595Z`, and `61583` rows with
  `processed_at IS NULL`.
- Torghut control-plane quant projections were very large and fresh in places:
  `quant_pipeline_health` estimated around `50.9M` rows, `quant_metrics_series` around `3.5M`, and
  `quant_metrics_latest` had `4032` rows with max `as_of` at `2026-05-07T06:29:32.195Z`.
- Torghut operational table statistics were materially stale. `pg_stat_user_tables` estimated `trade_decisions` at
  `17` rows while the exact count was `147623`; it estimated `execution_tca_metrics` and `executions` at `0` while
  exact counts were `13775` and `13778`.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` remains the highest-risk module. It is over `3000`
  lines and owns schedule runner generation, admission refresh, CronJob and ConfigMap reconciliation, workspace PVC
  state, requirement dispatch, freezes, and watch setup.
- `buildScheduleRunnerCommand` in that file builds a generated Bun command that refreshes current admission, mutates
  manifest annotations and parameters, and posts AgentRun or OrchestrationRun objects to Kubernetes.
- `reconcileScheduleRunnerStatus` already deletes runner resources when admission is blocked, but it does not settle
  cross-projection quality.
- `services/jangar/src/server/control-plane-cache-store.ts` already stores resource projections with `last_seen_at`,
  `deleted_at`, labels, annotations, and JSON payloads; it is the right data source for cache hygiene receipts.
- `services/jangar/src/server/control-plane-heartbeat-store.ts` already has typed component heartbeat rows and freshness
  checks; it is the right source for controller authority receipts.
- `services/jangar/src/server/control-plane-status.ts` composes dependency quorum, controller witness, material action
  verdicts, runtime admission, and workflow evidence. The new settlement should be a reducer consumed there, not more
  branching inside the schedule controller.
- Tests already cover PVC aliases, schedule runner commands, schedule admission, freeze and resume behavior, and
  runtime admission. The gap is projection-quality tests across cache, heartbeat, event, and rollout evidence.

## Problem

Jangar has too many truth surfaces and no single projection-quality settlement.

The surfaces are:

1. live Kubernetes objects and rollout events;
2. Argo CD sync and health state;
3. controller heartbeats and serving-process routes;
4. database read models such as `resources_current`;
5. raw event sinks such as GitHub events;
6. schedule and AgentRun terminal history;
7. database planner statistics that determine whether evidence queries remain cheap and trustworthy;
8. consumer evidence from Torghut that depends on Jangar being precise.

Each surface is useful. None is sufficient alone. A deployment can be available while its heartbeat lane is disabled.
A database projection can be fresh while mostly carrying deleted rows. An event sink can be recent while every row is
unprocessed. A trading service can be Healthy while GitOps convergence is not complete. Planner statistics can be so
stale that the system chooses the wrong query shape for a hot path.

The current architecture asks downstream gates to infer these differences from multiple fields. That is brittle. The
control plane should settle projection quality once, attach receipt ids to material verdicts, and let consumers decide
from explicit states.

## Alternatives Considered

### Option A: Add More Kubernetes Retry And Cleanup Logic

Pros:

- Directly reduces failed Job and pod clutter.
- Keeps the work inside existing controllers.
- Easy to explain as operational hygiene.

Cons:

- Does not explain heartbeat/deployment disagreement.
- Does not classify read-model drift or event-processing debt.
- Does not catch stale database planner statistics.
- Can make the cluster look cleaner while evidence quality remains ambiguous.

Decision: reject.

### Option B: Make The Database Projection The Primary Authority

Pros:

- Gives routes one efficient source.
- Uses existing `resources_current` and heartbeat stores.
- Avoids repeated Kubernetes reads in deployer tooling.

Cons:

- A projection can be fresh and still incomplete, deleted-heavy, or semantically stale.
- Database rows cannot by themselves prove Argo convergence or current pod readiness.
- It would over-trust the exact surface that currently has cache hygiene and planner-stat drift.

Decision: reject.

### Option C: Evidence Census And Projection Settlement Exchange

Pros:

- Settles every material projection with source refs, observed counts, freshness budget, and action effect.
- Makes cross-surface disagreement first-class evidence instead of route-specific interpretation.
- Gives deployer, engineer, and Torghut the same receipt ids.
- Lets Jangar keep local reducers while publishing one authoritative projection-quality contract.

Cons:

- Adds a new reducer, new route payload, and calibration work for freshness budgets.
- Requires careful query budgets so the census does not create database pressure.
- Adds one more gate that can hold material action during rollout if miscalibrated.

Decision: select Option C.

## Architecture

Jangar emits one evidence census per namespace and material consumer.

```text
evidence_census_run
  census_id
  namespace
  generated_at
  fresh_until
  jangar_revision
  source_refs
  projection_receipt_refs
  overall_state             # current, degraded, blocked
  material_action_effects
  reason_codes
```

Each surface emits a projection settlement receipt.

```text
projection_settlement_receipt
  receipt_id
  census_id
  projection_family         # rollout, argocd, heartbeat, resource_cache, event_sink, schedule, db_stats, consumer
  source_ref
  observed_at
  fresh_until
  state                     # current, stale, unprocessed, disabled, drifted, stats_stale, out_of_sync, blocked
  observed_counts
  expected_counts
  drift_budget
  query_budget
  materiality               # serve, dispatch, deploy, merge, torghut_capital
  allowed_effects
  blocked_effects
  reason_codes
```

The first production census covers:

- Kubernetes rollout receipt: deployment availability, recent readiness failures, Job failures, pod debt, and PDB
  warnings.
- Argo convergence receipt: Application health, sync status, material OutOfSync resource inventory, and revision.
- Heartbeat receipt: component heartbeat freshness and status compared with deployment availability.
- Resource cache receipt: row count, deleted-row ratio, max `last_seen_at`, and source watch freshness.
- Event sink receipt: received count, processed count, unprocessed age, and whether the sink is raw-only or action
  backing.
- Schedule receipt: active schedule inventory, last successful run, failed Job count, and active renewal bonds.
- Database statistics receipt: `pg_stat_user_tables` recency, exact-count spot checks for bounded operational tables,
  and cardinality-drift classification.
- Consumer receipt: Torghut dependency, TCA, market-context, and profit-stat state consumed by Jangar material gates.

### Action Semantics

- `serve_readonly` may remain allowed when projection receipts are degraded but serving health is current.
- `dispatch_repair` may remain allowed when degraded receipts are isolated, understood, and query budgets are healthy.
- `dispatch_normal` requires rollout, heartbeat, schedule, resource cache, and event sink receipts to be current or
  explicitly non-material.
- `deploy_widen` and `merge_ready` require rollout, Argo convergence, heartbeat, resource cache, and database
  statistics receipts to be current.
- `torghut_paper` requires Jangar receipts plus Torghut profit-stat, TCA, market-context, and promotion receipts to be
  current.
- `live_micro` requires every paper prerequisite plus current paper outcome and rollback receipts.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a projection-census reducer owned by `control-plane-status` or an adjacent server module.
- Read existing cache and heartbeat stores; do not create a new CRD for the first slice.
- Add bounded SQL helpers for resource-cache hygiene, event-sink backlog, heartbeat state, schedule outcome counts, and
  database-stat spot checks.
- Add Kubernetes/Argo receipts from existing status collection paths where available; avoid pod exec and Secret
  expansion.
- Expose `evidence_census`, `projection_settlement_receipts`, and receipt ids on material action verdicts.
- Add tests for deployment/heartbeat disagreement, deleted-heavy resource cache, unprocessed event sink, Argo
  OutOfSync plus Healthy, stale planner stats, and Torghut consumer hold.

Out of scope for the first implementation:

- Mutating Kubernetes resources or database rows from the census.
- Running `ANALYZE` automatically.
- Granting broader cluster RBAC.
- Replacing existing runtime admission, schedule lease, or stage renewal contracts.

## Validation Gates

Local validation:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-controller-witness.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/supporting-primitives-controller.test.ts`
- `bun run --filter @proompteng/jangar lint`
- `bun run --filter @proompteng/jangar tsc`

Cluster and database validation after deploy:

- `kubectl get deploy,pods,jobs -n agents`
- `kubectl get applications.argoproj.io -n argocd jangar agents torghut torghut-options`
- Read `/api/agents/control-plane/status?namespace=agents` and confirm every material action verdict carries evidence
  census receipt ids.
- Run read-only SQL against Jangar for `resources_current`, `component_heartbeats`, `agent_runs`,
  `workflow_comms.agent_messages`, and `jangar_github.events`.
- Run read-only SQL against Torghut for bounded operational table counts and planner-stat drift checks.
- Confirm no validation step requires pod exec, database mutation, or direct cluster apply.

## Rollout Plan

1. Ship census receipts in observe-only mode and keep existing gates primary.
2. Compare census verdicts against current material action verdicts for two schedule windows.
3. Attach census receipt ids to material action verdicts without changing allow/deny behavior.
4. Make deploy widening require current rollout, Argo, heartbeat, resource-cache, and database-stat receipts.
5. Make normal dispatch require current schedule and controller receipts.
6. Let Torghut consume Jangar census ids as a prerequisite for paper-readiness evaluation.

## Rollback Plan

- Stop consumers from reading `evidence_census` and receipt ids.
- Keep existing runtime admission, stage renewal, controller witness, and material action verdicts in force.
- Treat missing census as `unknown` and hold deploy widening while allowing current repair-only behavior.
- Leave observe-only receipt generation enabled for diagnosis unless route latency or database pressure increases.

## Risks And Mitigations

- **Census query pressure:** use bounded operational table checks, estimates for large quant tables, and explicit query
  budgets.
- **False deploy holds:** start in observe-only mode and compare for two schedule windows before enforcing.
- **Semantic overload:** publish one reduced receipt per projection family and keep raw details behind source refs.
- **Raw event sinks misclassified as failing:** allow a sink to declare raw-only semantics, but force that declaration
  into the receipt.
- **Planner-stat repair requires mutation:** the census can recommend maintenance, but deployer action must remain a
  separate, reviewed maintenance path.

## Handoff To Engineer

Build the reducer first, then wire consumers. The first useful artifact is a route payload that explains why an
otherwise healthy-looking control plane is still unsafe to widen. Keep every query bounded and every receipt tied to
source refs so deployer verification can reproduce the verdict.

## Handoff To Deployer

Treat the census as a rollout gate only after observe-only parity has held for two schedule windows. Hold deploy
widening if Argo is OutOfSync on material resources, a healthy deployment disagrees with its heartbeat receipt, the
resource cache is deleted-heavy without an explicit compaction receipt, event sinks carry material unprocessed debt, or
database planner statistics are materially stale. Do not mutate cluster or database state from validation; use the
receipts to decide whether to approve, pause, or request a maintenance PR.
