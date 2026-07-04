# 150. Jangar Controller Brownout Budgets And Proof-Spend Admission Exchange (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, controller brownout behavior, schedule debt, useful-work admission, Torghut
proof-spend coordination, validation, rollout, rollback, and implementation handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/154-torghut-marginal-proof-spend-portfolio-and-capital-repair-budget-2026-05-07.md`

Extends:

- `149-jangar-wrapper-truth-settlement-and-useful-evidence-gates-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `147-jangar-hot-path-witness-cache-and-repair-settlement-cells-2026-05-07.md`

## Decision

I am selecting a controller brownout budget and proof-spend admission exchange as the next Jangar control-plane
architecture step.

The evidence no longer says "Jangar cannot serve." Jangar is serving. The `jangar` namespace had the application,
database, Redis, Bumba, Open WebUI, and Symphony pods running. The Jangar control-plane status endpoint reported
database connectivity healthy, migration consistency healthy at `28/28`, and execution trust healthy. The current
failure mode is more specific: the controller plane is recovering work while also showing watch and probe debt. The
`agents` namespace retained `65` failed pods, `176` completed pods, and `9` running pods during the read-only probe.
The Agents API and controller deployments were available, but recent events showed readiness and liveness probe
failures, one controller pod restart, and watch reliability degraded with `2` errors and `5` restarts in a 15 minute
window.

I do not want to turn every transient brownout into a global stop. That would make the control plane brittle and would
block the repair work needed to clear the brownout. I also do not want to let every schedule, wrapper, and Torghut
proof repair compete equally during a controller brownout. That is how retained failed pods, fresh retries, and
expensive proof jobs can keep the system hot without increasing useful evidence.

The selected design makes controller capacity an explicit budget. Jangar will keep `serve_readonly` available when
the route, database, and local serving witness are healthy. It will issue scarce `AdmissionSpendToken` values for
work that consumes controller, API, database, or proof-query capacity. Normal dispatch, deploy widening, merge-ready,
and Torghut capital work require fresh budget. Repair work can run through a smaller zero-notional budget when it is
the highest expected unblock. The tradeoff is another reducer and a stricter admission surface. I accept that because
the current system needs graceful brownout behavior, not another all-green or all-red status badge.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes `controller_brownout_budget` in `/api/agents/control-plane/status`.
- The budget separates `serving_capacity`, `controller_capacity`, `schedule_capacity`, `database_evidence_capacity`,
  and `torghut_proof_capacity`.
- Each action class receives an explicit decision: `allow`, `defer`, `repair_only`, `hold`, or `block`.
- `serve_readonly` stays `allow` when serving route and database witnesses are healthy, even if watch reliability is
  degraded.
- `dispatch_repair` stays available only inside a bounded zero-notional repair quota.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` are held
  when brownout debt exceeds the action class budget.
- Schedules use budget-aware jitter/backoff instead of blind concurrent retries.
- Deployer checks consume one brownout receipt before widening Jangar or Torghut rollouts.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, or trading flags.

### Cluster And Rollout Evidence

- `jangar` namespace pods were running: `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`,
  `jangar-openwebui-redis-0`, `open-webui-0`, `symphony`, and `symphony-jangar`.
- `deployment/jangar`, `deployment/bumba`, `deployment/symphony`, and `deployment/symphony-jangar` were each
  available at `1/1`.
- The service account could list Jangar deployments and services, but could not list ReplicaSets or StatefulSets in
  `jangar`. That is not a serving outage, but it is a validation limitation that must be represented explicitly.
- `agents` namespace deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- `agents` pod phase summary was `176 Completed`, `65 Error`, and `9 Running`.
- Recent `agents` events showed successful newer swarm cron jobs after older retained failures, plus
  `BackoffLimitExceeded` for Torghut market-context batch jobs.
- Recent `agents` events also showed readiness and liveness probe failures against `agents` and
  `agents-controllers`, including connection refused and timeout responses before one controller pod restarted.
- `torghut` active service and simulation deployments were available at `1/1`, while older Knative revisions were
  scaled to `0/0`.
- `torghut` events included transient rollout readiness failures, duplicate ClickHouse PodDisruptionBudget warnings,
  and Flink status-modified-externally warnings. These were not rollback triggers by themselves, but they add rollout
  ambiguity that should consume deploy-widen budget.

### Jangar Status And Data Evidence

- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status` generated a response at
  `2026-05-07T14:24:43.278Z`.
- Database status was healthy: configured, connected, `latency_ms=3`.
- Migration consistency was healthy: table `kysely_migration`, `registered_count=28`, `applied_count=28`,
  `unapplied_count=0`, `unexpected_count=0`, latest registered and applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was degraded: `observed_streams=4`, `total_events=2694`, `total_errors=2`, and
  `total_restarts=5`.
- The degraded streams were not all equal. `agentruns.agents.proompteng.ai` carried `2693` events with no errors,
  while `approvalpolicies.approvals.proompteng.ai` and
  `orchestrationruns.orchestration.proompteng.ai` had the watch errors and restarts.
- Execution trust was healthy with no blocking windows.
- Direct CNPG SQL was blocked by RBAC: `pods/exec` was forbidden for `jangar-db-1`, and listing CNPG cluster objects
  was forbidden in `jangar`. The ordinary control-plane contract therefore must treat typed application health as the
  normal database witness and expose direct-inspection RBAC as a validation limitation.

### Torghut Consumer Evidence

- Torghut live `/readyz` returned HTTP `503` with `status=degraded`.
- Torghut live dependencies were healthy for Postgres, ClickHouse, Alpaca, database schema, Jangar universe, empirical
  jobs, and readiness cache.
- Torghut live submission gate was closed: `allowed=false`, `reason=simple_submit_disabled`,
  `capital_stage=shadow`.
- Torghut proof floor was `repair_only`, `capital_state=zero_notional`, with blocking reasons
  `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`, `market_context_stale`, and
  `simple_submit_disabled`.
- Execution TCA had `13,775` orders, `13,571` filled executions, latest computed time
  `2026-05-07T14:23:44.018621+00:00`, average absolute slippage `13.7594875295276693` bps, and guardrail `8` bps.
- Torghut empirical jobs were healthy for candidate `chip-paper-microbar-composite@execution-proof` and dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Torghut simulation `/readyz` was HTTP `200` in paper mode, with Postgres, ClickHouse, database schema, universe,
  and empirical jobs healthy. Its proof floor remained `repair_only` and `zero_notional`, but proof was not required
  in non-live mode.
- Direct CNPG SQL was also blocked for `torghut-db-1`; typed Torghut runtime endpoints are the normal data witness
  for this lane.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is `3301` lines and owns schedule reconciliation,
  swarm dispatch, workspace PVC reconciliation, and multiple watch loops.
- `services/jangar/src/server/primitives-kube.ts` is `690` lines and now includes first-class
  `PersistentVolumeClaim` aliases plus tests. The current risk is not missing PVC support; it is budgetless work
  admission while controller and watch debt are present.
- `services/jangar/src/server/control-plane-status.ts` is `787` lines and composes database, watch, execution trust,
  Torghut, material verdict, and runtime admission signals.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and is the right place to
  translate brownout debt into action-class reason codes.
- `services/jangar/src/routes/ready.tsx` is `193` lines. It should remain a serving readiness surface, not a proof
  scheduler.
- Focused tests already exist for supporting primitives, PVC aliases, watch reliability, control-plane status,
  negative evidence, and material action verdicts. The missing tests are pure brownout-budget reducer cases and
  schedule admission backoff cases.

## Problem

Jangar currently has enough signals to know that the system is serving and also under controller pressure, but it does
not have one admission budget that answers "what work can safely run now?"

The failure modes are:

1. A retained failed-pod tail can coexist with newer successful wrapper jobs, leaving operators to infer whether debt
   is historical, active, or still expensive.
2. Watch reliability can be degraded while core AgentRun watch traffic remains healthy, so a single degraded flag is
   too blunt for action admission.
3. Controller readiness flaps can happen while deployments stay available, so rollout health alone is not enough to
   widen work.
4. Repair and normal work currently compete for the same controller/API capacity during brownout.
5. Torghut proof repairs can be operationally healthy but economically unready, so Jangar needs to admit the repair
   with the highest expected unblock rather than every proof job that asks to run.

## Alternatives Considered

### Option A: Stop All Scheduled Work When Watch Reliability Is Degraded

Pros:

- Simple to explain.
- Protects the controller during the worst brownouts.
- Easy to implement with one feature flag.

Cons:

- Blocks the repair work needed to clear brownout debt.
- Treats an AgentRun-heavy healthy watch stream the same as a broken watch stream.
- Makes read-only serving look unavailable if readiness accidentally absorbs scheduling truth.

Decision: reject. It is safe but too coarse.

### Option B: Keep Existing Action Clocks And Add More Reason Codes

Pros:

- Lowest local implementation cost.
- Reuses the current material-action verdict and negative-evidence router.
- Avoids a new status section.

Cons:

- More reason codes do not allocate scarce capacity.
- Schedules still retry without a controller budget.
- Torghut repair work still lacks a common spend limit when multiple blockers are open.

Decision: reject as incomplete.

### Option C: Add A Brownout Budget And Proof-Spend Admission Exchange

Pros:

- Keeps serving readiness decoupled from proof production.
- Lets bounded repair proceed while holding normal dispatch and widening.
- Converts watch restarts, probe failures, retained schedule debt, DB inspection limits, and Torghut proof cost into
  one action-class budget.
- Gives engineer and deployer stages concrete gates to validate.

Cons:

- Adds a reducer and status schema.
- Requires careful tuning to avoid starving low-cost useful work.
- Needs observability so budget decisions are trusted rather than treated as another opaque hold.

Decision: select Option C.

## Architecture

Add a pure reducer named `controller-brownout-budget` under `services/jangar/src/server/`. The reducer consumes typed
snapshots and produces a `ControllerBrownoutBudget`:

- `budget_id`: deterministic hash of namespace, window, source revision, and observed debt.
- `namespace`: workload namespace.
- `window_started_at` and `window_ended_at`: evidence window.
- `serving_capacity`: route, local process, and database serving state.
- `controller_capacity_score`: score from controller pod availability, readiness probe failures, restarts, and
  heartbeat freshness.
- `watch_debt`: per-resource events, errors, restarts, and age.
- `schedule_debt`: active failed attempts, historical retained failures, later successful wrappers, and net debt.
- `database_evidence_capacity`: typed DB health plus direct inspection availability.
- `rollout_ambiguity`: deployment availability, rollout events, duplicate PDB matches, and GitOps/image convergence.
- `torghut_proof_capacity`: proof-floor blockers, proof query cost, TCA debt, market-context debt, and empirical
  readiness.
- `action_budgets`: per-action token counts and decisions.
- `reason_codes`: normalized reasons for the negative-evidence router.
- `fresh_until`: expiry timestamp for the budget.

Add `AdmissionSpendToken` as the unit consumed by schedules and material actions:

- `token_id`
- `action_class`
- `consumer`
- `max_dispatches`
- `max_notional`
- `expires_at`
- `required_receipts`
- `budget_ref`
- `reason_codes`

Action-class policy:

- `serve_readonly`: does not consume spend tokens when serving and DB witnesses are healthy.
- `dispatch_repair`: can consume a small repair token when the repair cites a settled warrant and zero notional.
- `dispatch_normal`: consumes a normal dispatch token and requires low active schedule debt.
- `deploy_widen`: consumes a rollout token and requires low rollout ambiguity plus fresh source-rollout truth.
- `merge_ready`: consumes a merge token and requires no stale direct evidence for the PR scope.
- `paper_canary`, `live_micro_canary`, `live_scale`: consume Torghut proof tokens from the companion contract.

Schedules do not need to know every proof detail. They need one admission answer before creating work:

```text
schedule runner asks: action_class + stage + target + source revision
brownout exchange returns: token, defer_until, or hold reason
runner creates work only when token is fresh
```

## Implementation Scope

Engineer stage:

- Add the `ControllerBrownoutBudget` and `AdmissionSpendToken` types.
- Add a reducer that converts current status, Kubernetes event summaries, watch reliability, schedule debt, and
  Torghut proof-floor summaries into action budgets.
- Add `controller_brownout_budget` to control-plane status without making route readiness depend on it.
- Feed budget reason codes into `control-plane-negative-evidence-router.ts`.
- Feed spend token IDs into material-action verdict evidence refs.
- Teach the supporting primitives scheduler to honor `defer_until` and bounded repair tokens before creating new
  scheduled work.
- Add tests for watch-degraded-but-serving-healthy, retained-failures-after-success, controller probe restart,
  direct-DB-inspection-forbidden, Torghut zero-notional repair, and deploy-widen hold.

Deployer stage:

- Roll out budget calculation in shadow mode for one day.
- Enable repair-only tokens first.
- Enable normal dispatch holds only after false-positive rate and schedule latency are measured.
- Enable deploy-widen and merge-ready holds after source-rollout truth exchange is wired.
- Enable Torghut proof-spend tokens only after the companion Torghut portfolio produces stable bids.

## Validation Gates

- Unit: serving remains allowed when database status is healthy and watch debt is degraded but non-serving.
- Unit: one failed cron attempt followed by a successful cron attempt has lower active debt than a still-open failed
  attempt.
- Unit: controller readiness restart reduces `dispatch_normal` and `deploy_widen` budgets without blocking
  `serve_readonly`.
- Unit: direct CNPG inspection forbidden is represented as `database_evidence_capacity.direct_inspection=blocked`,
  while typed DB health remains healthy.
- Unit: Torghut proof floor `repair_only` issues zero-notional repair tokens only.
- Integration fixture: status payload with `2` watch errors, `5` restarts, and `65` retained failed pods produces a
  conservative repair budget and holds deploy widening.
- Performance: reducer completes under 100 ms on a production-sized status fixture.
- Rollout: `/api/agents/control-plane/status` stays HTTP 200 if brownout reduction fails; the new section reports
  degraded rather than taking down serving.

## Rollout And Rollback

Rollout sequence:

1. `shadow`: compute and display budgets, no admission impact.
2. `repair-tokens`: require tokens only for repair dispatch created by supporting primitives.
3. `normal-dispatch`: hold normal dispatch during controller brownout.
4. `rollout-gates`: require deploy-widen and merge-ready tokens.
5. `torghut-proof-spend`: require Torghut proof-spend tokens for paper/live capital actions.

Rollback is configuration-first:

- Disable token enforcement and leave budget calculation in shadow.
- If budget calculation itself causes load, disable the reducer and keep the existing action clocks.
- Do not drop budget tables or schema during rollback; they are useful audit evidence.
- Keep capital at zero notional when Torghut proof floor is `repair_only`, even if budget enforcement is rolled back.

## Risks

- A too-strict budget can starve useful work. Mitigation: repair tokens stay available with zero notional and short
  expiry.
- A too-loose budget can hide brownout pressure. Mitigation: deploy-widen and merge-ready require the strictest
  budgets.
- Retained failed pods can overweight old failures. Mitigation: schedule debt must distinguish active, retained, and
  netted debt.
- Typed DB health can hide direct-inspection gaps. Mitigation: direct inspection is a separate capacity field, not a
  replacement for application health.

## Handoff Contract

Engineer acceptance gates:

- Reducer and type tests cover all validation gates above.
- Supporting scheduler honors `defer_until` without creating duplicate work.
- Status schema is additive and documented.
- Existing readiness route does not call the brownout reducer.

Deployer acceptance gates:

- Shadow budget appears in production status for at least one day.
- Repair-token mode does not increase failed pods or controller restarts.
- Normal-dispatch mode lowers retained active schedule debt.
- Deploy-widen mode blocks when controller probe debt or rollout ambiguity is present.
- Torghut capital stays zero notional unless the companion proof-spend portfolio and proof floor both allow widening.
