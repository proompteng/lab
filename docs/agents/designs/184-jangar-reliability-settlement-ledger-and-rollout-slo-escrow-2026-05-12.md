# 184. Jangar Reliability Settlement Ledger And Rollout SLO Escrow (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, AgentRun failure-mode reduction, PR-to-GitOps rollout latency, ready-status
truth, least-privilege database evidence, Torghut capital repair coordination, implementation gates, validation,
rollout, rollback, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/188-torghut-profit-freshness-frontier-and-zero-notional-repair-market-2026-05-12.md`

Extends:

- `183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
- `182-jangar-routeability-cutover-backpressure-and-proof-run-admission-2026-05-08.md`
- `180-jangar-stage-clearance-exchange-and-scheduler-routability-contract-2026-05-08.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

## Decision

I am selecting a **Jangar Reliability Settlement Ledger with Rollout SLO Escrow** as the next control-plane
architecture step.

The current cluster evidence is clear enough to choose. Jangar and Agents are available, Argo reports both applications
as `Synced` and `Healthy`, and the Jangar status route proves the database projection is healthy with 29 registered and
29 applied migrations. That is not the same as a healthy mission system. The AgentRun history has 48 failed
`jangar-control-plane` runs out of 295, with 29 classified as provider capacity exhaustion and 19 as backoff-limit
failures. A recent scheduled runner failed before launch because
`http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` returned
`ConnectionRefused`. The live status route also blocks dependency quorum on stale Torghut empirical proof while
material action verdicts hold normal dispatch, deploy widening, merge readiness, and paper capital.

The next system-level move is to make reliability settlement durable and action-class specific. Jangar should not let a
15-minute green workflow window erase a seven-day failure-debt pattern, and it should not let a green Deployment hide a
broken route, stale controller witness, stale downstream proof, or registry image-pull fault. The new ledger becomes the
single runtime packet that engineer and deployer stages must cite before they change code, launch runs, merge PRs, or
widen rollout.

The tradeoff is friction. Some runs will be held even when the immediate deployment is healthy. I accept that because
the business metric is not "launch more runs"; it is reduce failed AgentRuns and shorten green PR-to-healthy GitOps
rollout time. A held run with a typed repair reason is cheaper than another opaque backoff loop.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-12. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRuns, broker state, Torghut flags, or ClickHouse data.

### Cluster And Rollout Evidence

- Runtime scope was confirmed from the plan AgentRun: repository `proompteng/lab`, base `main`, head
  `codex/swarm-jangar-control-plane-plan`, mission ledger
  `/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md`, and business metric "reduce failed AgentRuns and
  shorten green PR-to-healthy GitOps rollout time for the Jangar control plane".
- NATS context soak read `workflow.general.>` and returned no filtered prior messages for this branch.
- Current branch was at `c11a2f48b8e1c18a5456311e9a3134d8dfc0ad0d`, the same revision Argo reported for `jangar`,
  `agents`, `torghut`, and `torghut-options`.
- `kubectl config current-context` was unset, but in-cluster auth worked for most read-only Kubernetes reads as
  `system:serviceaccount:agents:agents-sa`.
- `jangar` pods were running, including `deployment/jangar=1/1`; recent namespace events still showed transient
  `ImagePullBackOff` events for `jangar`, `bumba`, `symphony`, and `symphony-jangar` on current registry images.
- `agents` deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- `kubectl get agentruns -A` showed 620 total AgentRuns: 484 succeeded, 100 failed, 15 running, 5 pending, 12 template,
  and 4 with empty phase.
- For `jangar-control-plane` specifically, 295 runs included 240 succeeded, 48 failed, 2 running, and 5 pending.
  Failure reasons were `ProviderCapacityExhausted=29` and `BackoffLimitExceeded=19`. Stage failure counts were
  `discover=2`, `plan=3`, `implement=24`, and `verify=19`.
- CronJob history showed recent `jangar-control-plane-plan` and `implement` scheduled jobs failing for about 10 hours
  before newer runs succeeded or continued. The failed pod logs showed `ConnectionRefused` when fetching the Jangar
  control-plane status route before creating work.
- Argo reported `jangar=Synced/Healthy`, `agents=Synced/Healthy`, `torghut=Synced/Degraded`, and
  `torghut-options=Synced/Progressing`.
- Torghut had multiple pods in `ImagePullBackOff`, including `torghut-ws`, `torghut-ws-options`, `torghut-ta-sim`, and
  `torghut-options-ta`. `torghut-ws` had 2458 image pull backoff events over about 9 hours.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` already assembles controller health, database status, workflow
  reliability, watch reliability, execution trust, source rollout truth, material action verdicts, and Torghut consumer
  evidence. It is the right convergence surface.
- `services/jangar/src/server/control-plane-workflows.ts` measures active and recent failed workflow jobs, but the
  default route window is 15 minutes. That is too short to preserve the 48/295 `jangar-control-plane` failure pattern
  as admission evidence.
- `services/jangar/src/server/agents-controller/provider-capacity.ts` already recognizes provider capacity failures
  from retained job logs. The missing architecture is not detection; it is durable settlement, backpressure, and
  stage-specific admission.
- `services/jangar/src/server/control-plane-rollout-health.ts` correctly evaluates configured deployments, but it does
  not bind PR merge time, Argo revision, image digest availability, route readiness, database projection, and service
  health into one rollout SLO receipt.
- Jangar has focused tests for controller conditions, workflow runtime, control-plane status, watch reliability,
  execution trust, source rollout truth, material action verdicts, and database migration consistency. The missing
  regression surface is "green deployment plus stale failure debt must not authorize normal dispatch or merge-ready".
- `services/torghut/app/trading/**` already contains profit repair, evidence receipts, route reacquisition, proof
  floor, strategy hypotheses, market context, TCA, and empirical job reducers. Jangar should consume those as downstream
  proof, not recreate Torghut trading judgment.

### Database And Data Evidence

- Direct CNPG inspection with `kubectl cnpg psql` was blocked in both `jangar` and `torghut` because
  `agents-sa` cannot create `pods/exec`. Listing CNPG cluster resources and ClickHouseInstallation resources was also
  forbidden.
- The least-privilege database proof surface is therefore typed route evidence. Jangar control-plane status reported
  `database.configured=true`, `connected=true`, `status=healthy`, about `4 ms` latency, migration table
  `kysely_migration`, 29 registered migrations, 29 applied migrations, zero unapplied or unexpected migrations, and
  latest applied `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Torghut `/trading/status` reported the trading loop running but zero-notional: live submission was not allowed,
  blocked by `hypothesis_not_promotion_eligible`, `empirical_jobs_not_ready`, and `simple_submit_disabled`.
- Torghut data freshness was the primary business blocker: signal lag was about `328k` seconds, market context
  freshness was about `330k` seconds, all major market-context domains were stale, empirical jobs were stale, and no
  hypotheses were promotion-eligible.
- Jangar material action verdicts already held or blocked higher-risk actions with reasons that include controller
  witness gaps, workflow runtime unavailability, empirical job degradation, registry image-pull timeout, Torghut
  readiness degradation, and stale market/context/quant proof.

## Problem

Jangar has many useful evidence reducers, but the current operator path is still too implicit. The control plane can be
locally green while recent missions failed, downstream proof is stale, a registry pull fault is active, and a new
scheduled runner is about to fail before launch. That creates five failure modes:

1. Short-window truth hides long-window failure debt.
2. Provider capacity exhaustion is classified after failure instead of reducing future failed launches.
3. PR merge and Argo sync are not settled into a measurable "green PR-to-healthy rollout" receipt.
4. Database proof is available through typed routes, but direct RBAC failure is not represented as an explicit
   least-privilege evidence mode.
5. Engineer and deployer handoffs can cite a design doc without citing the current runtime settlement packet that says
   whether the action is allowed, held, or blocked.

## Alternatives Considered

### Option A: Keep Extending Material Action Verdicts

Add more blocking reasons to the existing material-action verdict reducer.

Advantages:

- Smallest implementation surface.
- Reuses a route that already drives action-class decisions.
- Low migration risk.

Disadvantages:

- It keeps failure debt embedded in per-action verdicts instead of making it auditable by stage, window, and source.
- It does not measure PR-to-rollout latency.
- It does not give schedulers a compact input for provider capacity backpressure.

Decision: useful as a consumer, not sufficient as the architecture.

### Option B: Create A Human Dashboard

Expose failure counts, Argo status, DB state, and Torghut freshness in a Jangar dashboard.

Advantages:

- Useful for oncall.
- Low risk to runtime launch logic.
- Easier to iterate visually.

Disadvantages:

- Dashboards do not reduce failed AgentRuns by themselves.
- Humans remain the admission controller.
- It does not satisfy the validation contract that implement and verify stages must cite governing runtime
  requirements before changing code or merging.

Decision: build a view later, but the first artifact must be machine-consumable.

### Option C: Reliability Settlement Ledger With Rollout SLO Escrow

Create a durable status reducer that settles failure debt, rollout health, database proof, downstream proof, and
stage-specific action posture into one packet. Material action verdicts and schedulers consume it.

Advantages:

- Preserves both short-window and long-window reliability truth.
- Converts provider capacity and route outages into launch backpressure before more failed runs are created.
- Gives PRs and deployers a measurable rollout receipt.
- Keeps database access least-privilege by accepting typed DB projections when direct CNPG exec is not allowed.
- Creates a single handoff contract for engineer and deployer stages.

Disadvantages:

- Adds one more status reducer to an already dense control-plane payload.
- Requires careful TTLs so historical failure debt does not block fixed systems indefinitely.
- Requires scheduler work to consume the ledger after the read model ships.

Decision: select Option C.

## Architecture

Jangar emits one `reliability_settlement_ledger` per status generation.

```text
reliability_settlement_ledger
  schema_version
  ledger_id
  namespace
  generated_at
  fresh_until
  governing_design_refs
  source_revision
  database_evidence_mode
  rollout_slo_escrow
  failure_debt_windows
  stage_admission
  action_class_overrides
  smallest_next_repairs
  handoff_contract
```

`failure_debt_windows` must include at least `15m`, `6h`, and `7d` windows. Each row records `scope`, `stage`,
`reason`, `count`, `first_observed_at`, `last_observed_at`, `sample_evidence_refs`, `value_gates`, `decision`, and
`expires_at`. Provider capacity debt can expire quickly after the provider recovers; registry image-pull and route
connection debt stays until a rollout or route receipt supersedes it.

`rollout_slo_escrow` binds a PR or GitOps revision to runtime facts:

```text
rollout_slo_escrow
  source_head_sha
  merged_at
  gitops_revision
  argo_app_statuses
  desired_images
  live_images
  deployment_rollouts
  route_health
  database_projection
  downstream_consumer_evidence
  pr_to_rollout_latency_seconds
  decision
  blockers
```

`stage_admission` is the compact surface for schedules and AgentRun creation. It reports `allow`, `hold`, or `block`
for `discover`, `plan`, `implement`, and `verify`, plus the governing design refs and runtime evidence refs that must
be copied into new work.

## Implementation Scope

Engineer milestone 1: add a Jangar reducer under `services/jangar/src/server/` that builds the ledger from existing
workflow reliability, AgentRun cache, material-action verdicts, rollout health, database status, execution trust, and
Torghut consumer evidence. Add unit tests for long-window failure debt, provider capacity debt expiry, RBAC-limited
database evidence mode, and action-class mapping.

Engineer milestone 2: project the ledger from `/api/agents/control-plane/status?namespace=agents` and update the
control-plane UI data types. Add route tests proving `ready_status_truth` stays degraded when deployment health is green
but ledger debt is active.

Engineer milestone 3: wire schedule-runner admission to read `stage_admission`. When a stage is held, it should avoid
creating doomed AgentRuns and emit a typed `SkippedByReliabilitySettlement` reason with the smallest repair.

Deployer milestone: prove a green PR-to-healthy rollout receipt after merge by collecting PR merge timestamp, Argo app
revision, deployment readiness, route status, DB projection, and downstream Torghut proof.

## Validation Gates

- `failed_agentrun_rate`: seven-day Jangar control-plane failure count and rate must be visible in the ledger, and new
  provider-capacity holds must reduce repeated failed launches instead of only classifying them after the fact.
- `pr_to_rollout_latency`: every merged implementation PR must have a rollout SLO receipt with source revision, Argo
  revision, deployment readiness, and route/database health timestamps.
- `ready_status_truth`: deployment readiness alone is not enough. The ledger is healthy only when route, DB projection,
  workflow reliability, execution trust, and required downstream proof are fresh or explicitly repair-only.
- `manual_intervention_count`: held schedules must name one smallest repair action so operators do not chase broad
  "degraded" states.
- `handoff_evidence_quality`: engineer and deployer handoffs must cite this doc, the ledger id, command exit codes,
  tests, rollout refs, unresolved issues, risk, rollback, and exact next action.

## Rollout And Rollback

Roll out in shadow first. The ledger is emitted but not consumed by schedule-runner admission. Deployer verifies that
the payload matches current material-action verdicts and does not invent blockers absent from evidence.

Enable scheduler consumption for one stage at a time: `plan`, then `discover`, then `verify`, then `implement`.
`implement` is last because it has the highest observed failure count and the highest cost when held incorrectly.

Rollback is a config-only disable of scheduler consumption. The ledger route remains read-only and should stay enabled
for diagnostics unless it corrupts status generation. If status generation fails, rollback target is the previous
control-plane status reducer set with material-action verdicts still active.

## Risks

- Historical debt can outlive the incident. Mitigation: each debt row carries `expires_at` and a superseding receipt
  rule.
- Scheduler holds can starve useful repair runs. Mitigation: `dispatch_repair` remains available for one named repair
  with bounded runtime and dispatch count when route and DB projection are readable.
- Direct DB RBAC gaps can be confused with DB failure. Mitigation: represent `route_projection` as a first-class
  database evidence mode and separately record the RBAC blocker.
- The payload can become too large. Mitigation: keep samples bounded and link to durable evidence refs.

## Handoff

Next engineer action: implement milestone 1 in Jangar as a read-only status reducer and test it against the observed
cases: 48/295 Jangar failures, provider capacity exhaustion, backoff-limit jobs, Jangar route connection refusal,
healthy DB migration projection, Torghut degraded Argo state, stale Torghut empirical proof, and registry image-pull
faults.

Next deployer action: after the implementation PR merges, collect the rollout SLO receipt and prove Argo sync, workload
readiness, Jangar status route health, database projection health, and Torghut consumer evidence freshness before
declaring the rollout healthy.
