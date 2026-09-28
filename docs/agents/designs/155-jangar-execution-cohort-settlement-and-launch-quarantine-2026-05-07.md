# 155. Jangar Execution Cohort Settlement And Launch Quarantine (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane reliability, schedule-runner cohort settlement, source provenance, launch quarantine,
rollout safety, Torghut capital handoff, validation, rollback, and implementation acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md`

Extends:

- `154-jangar-source-provenance-leases-and-material-action-escrow-2026-05-07.md`
- `153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`
- `150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`

## Decision

I am selecting execution cohort settlement with launch quarantine as the next Jangar control-plane architecture step.

The live system is available, but availability is hiding a cohort integrity problem. Jangar and Agents deployments are
ready, runtime proof cells are sealed, the database migration surface is current, and watch reliability is healthy.
At the same time, the Agents namespace still carries 68 failed pods and 19 failed jobs, plus five running jobs, across
old and current runner image digests. The status route can prove the current serving image, but it also observes
running workflow pods from earlier images. Source and GitOps revision are still missing, controller witness remains
split, and material actions are correctly held.

The next reliability gain is to stop treating all retained execution evidence as one flat live surface. Jangar should
settle every launch-capable schedule, job, and AgentRun into an `execution_cohort_settlement` keyed by source SHA,
GitOps revision, desired image digest, live image digest, admission passport, recovery warrant, stage, and schedule.
A launch quarantine then decides whether a cohort may create more work, may only run bounded repair, or must be
retired from material decisions while remaining audit-visible.

The tradeoff is more explicit bookkeeping. I accept that. The current system already pays the cost through status
noise, mixed image evidence, and repeated human interpretation. A cohort settlement turns that noise into a compact
decision surface that engineers can implement and deployers can gate.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `execution_cohort_settlements` and
  `launch_quarantine`.
- Every launch-capable schedule, schedule-runner job, workflow job, and AgentRun belongs to exactly one cohort.
- Cohort IDs include source SHA, GitOps revision, desired image digest, live image digest, admission passport,
  recovery warrant, stage, schedule name, and controller generation when those values are known.
- A cohort with missing source or GitOps revision can serve read-only evidence but cannot widen dispatch, merge, or
  admit Torghut capital.
- A cohort with mixed live image digests is `quarantined` until old running jobs finish or are explicitly retired by
  TTL policy.
- Retained failed pods and jobs stay audit-visible but stop counting as current launch blockers after cohort
  settlement records their terminal reason and expiry.
- `dispatch_repair` can be allowed only for a bounded cohort with current controller witness or a named witness-repair
  exception.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` require a
  current active cohort and no quarantined parent cohort.
- Deployer checks consume the cohort settlement and launch quarantine result instead of independently counting pods,
  jobs, images, runtime kits, and source leases.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- The Kubernetes current-context was unset, but `kubectl auth whoami` succeeded through the in-cluster service account:
  `system:serviceaccount:agents:agents-sa`.
- `jangar` deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- The active Jangar pod was `jangar-67ffbb64-dlrs5`, running
  `registry.ide-newton.ts.net/lab/jangar:40200cfe@sha256:360789a70b5cf33772de630b3a07b1c1433cbfe89869725c1e28551652a39582`.
- `agents` deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents pod phase counts were `Running=9`, `Succeeded=174`, and `Failed=68`.
- Agents job condition counts were `Complete=176`, `Failed=19`, and `Running=5`.
- Recent Agents events showed successful schedule wrapper jobs and AgentRun step launches, but also fresh readiness
  probe timeouts on `agents` and both controller pods.
- Retained failed pods included older discover, plan, implement, and verify schedule-runner pods from about 11-12
  hours earlier.
- Current running jobs included current-image plan work and older-image Torghut verify work, so live execution evidence
  is not a single image cohort.
- The service account cannot create `pods/exec` in `jangar` or `torghut`, cannot list Knative services in `torghut`,
  and cannot list CNPG cluster resources in either namespace.

### Jangar Status And Database Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` generated at `2026-05-07T16:23:58.936Z`.
- Jangar database status was healthy: configured, connected, `latency_ms=7`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Rollout health was healthy for `agents` and `agents-controllers`.
- Execution trust was healthy with no blocking windows.
- Watch reliability was healthy over a 15 minute window: six observed streams, 3039 total events, zero errors, and
  five restarts. The restarts were nonblocking but should be attributed to a cohort rather than flattened.
- `source_rollout_truth_exchange` was shadow mode, had `source_head_sha=null` and `gitops_revision=null`, and held
  `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`.
- `source_rollout_truth_exchange` blocked `live_micro_canary` and `live_scale`.
- The active blocking reason remained `source_rollout_truth_missing:source_or_gitops_revision`.
- Controller heartbeat evidence was split: deployment and watch epoch were current, but controller ingestion
  self-report was missing.
- `route_stability_escrow` allowed `serve_readonly` and `torghut_observe`, held dispatch and merge classes, and
  blocked live capital classes.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and already assembles many reducers into one
  status payload.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` is 632 lines and identifies missing
  source or GitOps revision, but it does not settle Kubernetes jobs into source/image cohorts.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is 528 lines and consumes action evidence,
  but it still receives flat status evidence rather than a launch cohort decision.
- `services/jangar/src/server/control-plane-route-stability-escrow.ts` is 490 lines and can consume cohort truth.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is 610 lines and already carries controller
  witness split as current runtime negative evidence.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 3301 lines and owns schedule creation, schedule
  status, dispatch, runtime admission stamps, and launch behavior. It is the risk center for cohort implementation.
- Tests exist for controller witness, source rollout truth through status assembly, material action verdict, route
  stability escrow, negative evidence routing, watch reliability, and runtime admission.
- The missing test surface is execution cohort grouping across old failed pods, current running jobs, mixed runner
  image digests, missing source/GitOps revision, and launch quarantine decisions.

### Torghut Capital Evidence

- Torghut rolled forward to live revision `torghut-00272` and simulation revision `torghut-sim-00372`.
- Both active revisions were available at `1/1` and used
  `registry.ide-newton.ts.net/lab/torghut@sha256:05fd4b6fc045a50adb049acc98c34278592cea12786aa08597d259ea05c0b464`.
- Live `/readyz` returned HTTP `503` with `status=degraded`.
- Simulation `/readyz` returned HTTP `200`, but simulation proof floor was still `repair_only` and zero-notional.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, empirical jobs,
  DSPy non-live mode, and database schema.
- Live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`, with one branch and
  known parent-fork warnings.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live TCA had 7334 orders, 7245 filled executions, zero routeable symbols, five blocked symbols, three missing
  symbols, average absolute slippage `13.8203637593029676` bps, and guardrail `8` bps.
- Live quant evidence had fresh latest metrics but `max_stage_lag_seconds=524848`.
- Simulation had one routeable symbol (`NVDA`) and seven missing symbols, so it is not a paper-capital release signal.

## Problem

Jangar has strong point-in-time readiness and weak execution cohort settlement. That leaves four concrete failure
modes:

1. A healthy deployment rollout can coexist with retained failed schedule-runner pods from old images.
2. Current status can observe multiple runner digests without saying which digest owns the next launch decision.
3. Source and GitOps revision can be missing while runtime proof cells and serving image parity look healthy.
4. Torghut capital can ask for Jangar proof while the launch surface still mixes old, current, failed, and running
   cohorts.

The system needs a compact answer to a simple deployer question: which execution cohort is allowed to create more work
right now, and which old cohorts are merely audit evidence?

## Alternatives Considered

### Option A: Keep Pod And Job Counts As Operational Context Only

Pros:

- No new runtime object.
- Engineers can continue to inspect pods and jobs directly.
- Existing status reducers keep their current shape.

Cons:

- Pod counts do not encode source SHA, GitOps revision, passport, warrant, or schedule ownership.
- Failed retained pods can look like current launch risk even after a later cohort recovered.
- Mixed running image digests remain a manual interpretation problem.

Decision: reject. This is exactly the ambiguity the current evidence exposes.

### Option B: Tighten Source Provenance Leases Only

Pros:

- Builds directly on the current selected design.
- Missing source/GitOps revision remains the right hard blocker.
- Keeps the implementation surface small.

Cons:

- Source provenance still does not classify old failed jobs or mixed running runners.
- Launch-capable schedules can be blocked or released without a cohort-level history of what happened.
- Torghut capital still cannot cite the execution cohort that produced its evidence.

Decision: reject as incomplete. Source provenance is required, but not sufficient.

### Option C: Add Execution Cohort Settlement And Launch Quarantine

Pros:

- Turns pod/job/image/source/admission evidence into one deployer-grade decision.
- Preserves audit evidence while preventing old failed cohorts from contaminating current material gates.
- Lets repair dispatch be bounded by cohort, schedule, source, and controller witness.
- Gives Torghut capital receipts a Jangar cohort reference rather than a loose status timestamp.

Cons:

- Adds a reducer and a quarantine policy.
- Requires careful TTL and terminal-state handling so audit retention and live launch gates do not fight.
- Forces engineers to fix source/GitOps provenance before normal dispatch can widen.

Decision: select Option C.

## Architecture

Add a pure reducer named `control-plane-execution-cohort-settlement` under `services/jangar/src/server/`. It should not
query Kubernetes or databases directly. It consumes already-collected status evidence: resources, jobs, pods, runtime
admission, source rollout truth, controller witness, watch reliability, database status, route stability, and material
action verdicts.

`ExecutionCohortSettlement` fields:

- `cohort_id`
- `cohort_kind`: `serving`, `schedule_runner`, `agent_run`, `workflow_job`, `torghut_capital`, or `repair`
- `namespace`
- `stage`
- `schedule_name`
- `source_head_sha`
- `gitops_revision`
- `desired_image_digest`
- `live_image_digests`
- `admission_passport_id`
- `recovery_warrant_id`
- `controller_generation`
- `started_at`
- `last_observed_at`
- `terminal_at`
- `pod_count`
- `job_count`
- `failed_pod_count`
- `failed_job_count`
- `running_job_count`
- `succeeded_job_count`
- `watch_restart_count`
- `database_projection_ref`
- `controller_witness_ref`
- `source_rollout_truth_ref`
- `material_action_verdict_refs`
- `settlement_state`: `current`, `repair_only`, `quarantined`, `retired`, `expired`, or `contradicted`
- `decision`: `allow`, `repair_only`, `hold`, or `block`
- `blocking_reason_codes`
- `fresh_until`
- `audit_retention_until`
- `rollback_target`

`LaunchQuarantine` fields:

- `quarantine_id`
- `generated_at`
- `fresh_until`
- `active_cohort_id`
- `retired_cohort_ids`
- `quarantined_cohort_ids`
- `allowed_action_classes`
- `repair_only_action_classes`
- `held_action_classes`
- `blocked_action_classes`
- `max_new_schedule_jobs`
- `max_new_agent_runs`
- `max_runtime_seconds`
- `required_repair_actions`
- `deployer_summary`
- `rollback_target`

Decision rules:

- `serve_readonly` may remain `allow` when serving, database, route, and watch evidence are current, even if older
  schedule cohorts are retired.
- `torghut_observe` may remain `allow` with zero notional when the active cohort is current or repair-only.
- `dispatch_repair` requires one active repair cohort, no mixed current live image digests for that schedule, and a
  named repair objective.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require an active current cohort with source SHA, GitOps
  revision, image parity, sealed warrant, allowed passport, current controller witness, and no quarantined parent.
- `paper_canary` requires the same active current cohort plus a Torghut capital cohort receipt.
- `live_micro_canary` and `live_scale` are blocked unless Jangar and Torghut cohort receipts are both current and live
  capital proof is explicit.
- Failed terminal pods older than the settlement TTL move to `retired`, keep audit refs, and stop affecting live
  launch decisions.
- Running jobs on old image digests keep their cohort `quarantined` until they finish, expire, or are explicitly
  superseded by policy.

## Validation Gates

Engineer acceptance gates:

- Add unit tests for cohort grouping by schedule, stage, image digest, passport, warrant, and source/GitOps revision.
- Add fixtures for 68 failed retained pods, five running jobs, mixed runner digests, and current healthy deployments.
- Prove retained failed pods move to `retired` after terminal settlement while staying present in audit refs.
- Prove an old running image digest keeps only that cohort quarantined and does not block `serve_readonly`.
- Prove missing source/GitOps revision holds dispatch, deploy widen, merge-ready, and capital classes.
- Prove `dispatch_repair` can be bounded by cohort with `max_new_agent_runs=1` and a finite runtime budget.
- Extend `control-plane-status.test.ts` to assert `execution_cohort_settlements` and `launch_quarantine` are present.
- Keep the reducer pure; Kubernetes calls stay in existing collectors.

Deployer acceptance gates:

- Read `/api/agents/control-plane/status?namespace=agents` and show `launch_quarantine.active_cohort_id`.
- Confirm `launch_quarantine.decision` for `dispatch_normal`, `deploy_widen`, and `merge_ready` before rollout widen.
- Confirm retired failed pods are represented by settlement audit refs rather than live blockers.
- Confirm any old-image running job is either complete, expired, or isolated to a quarantined cohort before merge-ready.
- Confirm Torghut paper/live capital decisions cite a Jangar cohort ID.

Suggested targeted validation commands:

```bash
bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts
bun run --cwd services/jangar test -- src/server/__tests__/control-plane-route-stability-escrow.test.ts
bun run --cwd services/jangar test -- src/server/__tests__/control-plane-material-action-verdict.test.ts
bun run --cwd services/jangar lint
bunx oxfmt --check docs/agents/designs/155-jangar-execution-cohort-settlement-and-launch-quarantine-2026-05-07.md
```

## Rollout Plan

Phase 1 publishes `execution_cohort_settlements` and `launch_quarantine` in shadow mode. Existing readiness, source
rollout truth, route stability, and material action verdict behavior remains authoritative.

Phase 2 teaches deploy verification to read launch quarantine and print the active, retired, and quarantined cohorts.
No action class changes yet.

Phase 3 lets `dispatch_repair` consume launch quarantine for one named repair cohort at a time. Normal dispatch and
merge-ready remain held unless source/GitOps provenance is current.

Phase 4 makes `merge_ready` and `deploy_widen` consume launch quarantine. Old failed cohorts can no longer block a
clean current cohort, but mixed running digests still hold widen.

Phase 5 allows Torghut paper-capital receipts to cite Jangar cohort IDs. Live capital remains blocked until the
companion Torghut contract passes.

## Rollback

- Disable launch quarantine consumption and keep existing source rollout truth plus material action verdicts in charge.
- Continue publishing cohort settlements as audit-only evidence if the reducer is healthy.
- If the reducer fails, omit `execution_cohort_settlements` or mark `launch_quarantine.status=unknown`; do not fail
  `/ready`.
- Keep `serve_readonly` available when route, database, and serving image evidence are healthy.
- Keep all capital classes zero-notional while cohort settlement is unavailable.

## Risks And Mitigations

- Risk: cohort grouping can accidentally retire a current failure. Mitigation: only terminal pods/jobs with stable
  owner refs and expiry can retire; running resources stay current or quarantined.
- Risk: old failed pods hide an active regression. Mitigation: current cohorts still count recent failures before TTL,
  and deployer summaries show retired cohort counts.
- Risk: source/GitOps revision remains unavailable. Mitigation: launch quarantine makes that the explicit repair target
  and prevents normal dispatch from widening.
- Risk: adding another reducer increases status complexity. Mitigation: keep it pure, test it with fixtures, and expose
  only compact summaries to deployers.
- Risk: Torghut capital overfits to a paper/sim cohort. Mitigation: capital actions require both Jangar and Torghut
  cohort receipts for the same proof window.

## Handoff To Engineer

Implement `control-plane-execution-cohort-settlement` as a pure reducer and wire it into
`control-plane-status.ts`. Start with shadow-only output and fixtures that reproduce the current evidence: 68 failed
Agents pods, 19 failed jobs, five running jobs, mixed runner image digests, missing source/GitOps revision, healthy
rollout, healthy database, healthy watch, and split controller witness.

Do not add Kubernetes queries inside the reducer. Use existing collectors and types. Keep the implementation below the
module-size cap or split helper logic immediately.

## Handoff To Deployer

Before widening or merging an implementation PR, require:

- `launch_quarantine.active_cohort_id` is present.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` are `allow` only when source/GitOps provenance is current.
- Retained failed pods are settled into retired cohorts with audit refs.
- Any running old-image job is isolated to a quarantined cohort.
- Torghut paper/live actions cite a Jangar cohort ID and keep `max_notional=0` unless the companion Torghut gates pass.

## Open Questions

- What TTL should retire terminal schedule-runner pods: one hour, one schedule period, or a stage-specific value?
- Should the controller write settlement ConfigMaps for offline audit, or is database-backed status enough?
- Should old running jobs be cancelled by GitOps policy after quarantine, or only held from future launches?
- What is the minimum source/GitOps evidence producer that can make source provenance current for schedule-runner
  cohorts?
