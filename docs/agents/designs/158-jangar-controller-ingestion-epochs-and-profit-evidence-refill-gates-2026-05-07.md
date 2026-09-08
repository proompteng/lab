# 158. Jangar Controller Ingestion Epochs And Profit Evidence Refill Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, split-topology controller authority, schedule launch safety, source and
database evidence settlement, Torghut profit-evidence refill admission, validation, rollout, rollback, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/162-torghut-profit-evidence-refill-and-capital-route-reentry-2026-05-07.md`

Extends:

- `155-jangar-execution-cohort-settlement-and-launch-quarantine-2026-05-07.md`
- `153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`

## Decision

I am selecting controller ingestion epochs with profit-evidence refill gates as the next Jangar control-plane
architecture step.

The current system is available, but availability is not the same as authority. The Jangar database is connected and
schema-current. Watches are healthy. The split `agents-controllers` deployment is running two available replicas.
At the same time, `/api/agents/control-plane/status?namespace=agents` still reports `agentrun_ingestion.status=unknown`
with message `agents controller not started`, source and GitOps revision are absent, route stability is in
`escrow_repair_only`, and material action classes are held by controller/source witness split. Torghut is reachable,
but the capital-facing proof surface is also incomplete: forecast registry is empty, empirical jobs are stale, and the
Jangar quant projection for `paper/1d` has zero latest metrics.

The next design should stop asking every reducer to infer controller truth from local process state, pod counts, and
status timestamps. Jangar should publish explicit `controller_ingestion_epochs` from the controller deployment and
require those epochs before schedule launch, dispatch widening, merge readiness, and Torghut profit-evidence refill.
An epoch is valid only when it binds the controller pod, deployment revision, source or GitOps ref when known, watch
high-watermarks, database projection, and observed AgentRun ingestion high-watermark. Torghut refill can then use a
bounded repair gate instead of trying to turn stale or empty profit evidence into capital authority.

The tradeoff is one more authority object. I accept that because the current alternative is worse: multiple reducers
already carry the same contradiction, but none of them owns the resolution.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `controller_ingestion_epochs` with one active epoch per
  controller authority source.
- Each active epoch includes controller deployment name, pod UID, controller image digest, database projection ref,
  watch reliability ref, source head SHA or GitOps revision if known, AgentRun high-watermark, and freshness expiry.
- `agentrun_ingestion.status` is no longer `unknown` when a split-topology controller has produced a fresh ingestion
  epoch.
- Source/GitOps absence continues to block `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`,
  `live_micro_canary`, and `live_scale`, but it does not block read-only status or bounded evidence-refill repair.
- Schedule runner fire-time admission rejects launches when the schedule carries an expired or mismatched ingestion
  epoch.
- Torghut profit-evidence refill requests are admitted only under `dispatch_repair` and only when the requested refill
  names the active ingestion epoch and a bounded evidence class.
- Deployer gates can decide from `active_ingestion_epoch.status`, `source_rollout_truth_exchange.deployer_summary`,
  and `profit_evidence_refill_gate.decision` without independently interpreting controller-local state.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records, GitOps
resources, AgentRun objects, broker state, ClickHouse tables, or trading flags.

### Cluster And Rollout Evidence

- The Kubernetes current context was unset, but `kubectl auth whoami` succeeded as
  `system:serviceaccount:agents:agents-sa`.
- `jangar` serving was running on image
  `registry.ide-newton.ts.net/lab/jangar:2214e91f@sha256:b059ad6762dc409b2b80e18fbeaca66c307243532c987867285a55dfe82a3c93`.
- Jangar namespace pods were running, including `jangar`, `bumba`, `jangar-db-1`, Alloy, Open WebUI, Symphony, and
  `symphony-jangar`.
- `agents` deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents pod phase counts were `Running=10`, `Completed=173`, and `Error=69`.
- Recent Agents events showed controller readiness/liveness timeouts during the rollout, then successful creation of
  current-image schedule runner jobs.
- Torghut pods were mostly running after the active 00274/00374 rollout; `torghut-whitepaper-autoresearch-profit-target`
  remained in `Error`.
- The service account cannot list CNPG cluster resources, cannot exec into `jangar-db-1` or `torghut-db-1`, and cannot
  list Knative services or revisions in the Torghut namespace.

### Jangar Status And Database Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` returned controller heartbeats as healthy for
  `agents-controller`, `supporting-controller`, and `orchestration-controller`.
- Jangar database status was healthy: configured, connected, `latency_ms=2`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was healthy over a 15 minute window with four observed streams, 2753 events, zero errors, and four
  restarts.
- `agentrun_ingestion.status` was `unknown` with message `agents controller not started`, which contradicts the fresh
  split-controller heartbeat and rollout evidence.
- `source_rollout_truth_exchange.deployer_summary.settlement_state` was `heartbeat_projection_split`.
- `source_rollout_truth_exchange` held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `paper_canary`, `live_micro_canary`, and `live_scale` because source/GitOps truth and controller ingestion witness
  were not current.
- `route_stability_escrow.route_stability_window.state` was `escrow_repair_only`, allowing `serve_readonly` and
  `torghut_observe` while holding dispatch and capital actions.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` assembles database, controllers, watches, source rollout truth,
  material verdicts, route stability, execution trust, empirical services, and namespace summaries into one status
  payload.
- `services/jangar/src/server/control-plane-db-status.ts` already provides a useful schema-current projection, but it
  does not bind that projection to controller ingestion high-watermarks.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule creation, fire-time schedule runner
  commands, runtime admission checks, swarm scheduling, requirement dispatch, and Workspace PVC reconciliation.
- `buildScheduleRunnerCommand()` verifies current admission passports and recovery warrants at fire time, but it does
  not verify a controller ingestion epoch.
- `reconcileSchedule()` generates CronJobs and ConfigMaps for launch, but schedule status remains separate from
  controller ingestion authority.
- `reconcileWorkspace()` now supports PVC-backed Workspace resources, which is a useful storage primitive but not an
  ingestion authority bridge.
- Tests cover schedule admission traces, fire-time admission settings, runtime proof checks, Workspace PVC
  reconciliation, and source rollout truth reducers. The missing test surface is split-controller ingestion authority:
  healthy heartbeat plus unknown local ingestion must produce a bounded repair state, not an ambiguous status.

### Torghut Evidence

- `GET http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503.
- `GET /trading/autonomy` reported `enabled=false`, `forecast_service.status=degraded`, message `registry_empty`,
  and `lean_authority.status=disabled`.
- Torghut empirical jobs were degraded and stale for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- Jangar quant health for `account=paper&window=1d` returned `status=degraded`, `latestMetricsCount=0`,
  `emptyLatestStoreAlarm=true`, and no pipeline stages.
- Torghut metrics still exposed useful raw trading facts: signal lag was 23 seconds, feature null rates were zero,
  TCA order count was 7334, average absolute slippage was about 13.82 bps, alpha readiness had three hypotheses, zero
  promotion eligible hypotheses, and three rollback-required hypotheses.

## Problem

The control plane is carrying three distinct truths without an authority boundary:

1. The controller deployment is healthy and producing heartbeat evidence.
2. The serving process says AgentRun ingestion is unknown because its local controller singleton is not started.
3. Material actions are correctly held because source/GitOps truth and controller ingestion witness are incomplete.

That ambiguity is manageable for a human reading the status payload, but it is not acceptable as a six-month control
plane contract. Engineers and deployers need to know whether the next action is safe read-only observation, bounded
repair, normal dispatch, merge, paper capital, or live capital. Torghut needs the same answer before it refills stale
profit evidence or promotes capital.

## Alternatives Considered

### Option A: Treat Split-Controller Heartbeat As Sufficient

Pros:

- Smallest implementation.
- Controller rollout is already healthy.
- It would reduce noisy holds quickly.

Cons:

- Heartbeat does not prove the controller observed or settled AgentRuns after rollout.
- It would mask the current `agentrun_ingestion.unknown` contradiction.
- It gives Torghut a weak authority ref for profit-evidence refill and capital gates.

Decision: reject. Heartbeat is necessary but not sufficient.

### Option B: Block All Material Actions Until Source/GitOps Truth Is Present

Pros:

- Strict fail-closed behavior.
- Simple deployer rule.
- Aligns with existing source rollout truth exchange.

Cons:

- It prevents safe repair of stale or empty evidence surfaces that are needed to restore the proof floor.
- It does not resolve controller ingestion ambiguity.
- It treats bounded refill, normal dispatch, merge, and capital as the same risk class.

Decision: reject as too blunt.

### Option C: Add Controller Ingestion Epochs And Profit-Evidence Refill Gates

Pros:

- Converts split-controller ambiguity into an explicit epoch.
- Keeps source/GitOps absence as a hard gate for material widening while allowing bounded repair.
- Lets schedule runners verify the epoch at fire time.
- Gives Torghut a first-class Jangar authority ref for stale empirical job and empty quant projection repair.

Cons:

- Adds a new reducer, tests, and status schema.
- Requires the controller process to publish high-watermarks instead of relying on local singleton state.
- Requires deployers to learn one more gate.

Decision: select Option C.

## Architecture

Add `controller_ingestion_epochs` to the Jangar status model. The reducer should consume controller heartbeats,
rollout health, watch reliability, database status, AgentRun watch state, and source rollout truth.

`ControllerIngestionEpoch` fields:

- `epoch_id`
- `namespace`
- `controller_name`
- `controller_deployment`
- `controller_pod`
- `controller_pod_uid`
- `controller_image_digest`
- `source_head_sha`
- `gitops_revision`
- `database_projection_ref`
- `watch_reliability_ref`
- `agentrun_high_watermark_ref`
- `observed_run_count`
- `terminal_run_count`
- `unknown_ingestion_reason`
- `issued_at`
- `fresh_until`
- `status`: `valid`, `repair_only`, `stale`, or `blocked`
- `allowed_action_classes`
- `held_action_classes`
- `blocked_action_classes`
- `reason_codes`

The status reducer should derive one `active_controller_ingestion_epoch`. A valid epoch requires:

- Fresh controller heartbeat from the split controller deployment.
- Database status `healthy` with migration consistency `healthy`.
- Watch reliability `healthy` with zero errors in the active window.
- An AgentRun high-watermark from the controller process, not the serving-local singleton.
- Source or GitOps revision when the requested action is material widening, merge readiness, or capital admission.

Repair-only is allowed when the first three checks pass but the high-watermark or source/GitOps ref is missing. That is
the current observed state and it should be named directly.

Add `profit_evidence_refill_gate` to the Jangar status model. It consumes the active ingestion epoch, Torghut empirical
service state, Jangar quant health, and route stability escrow. It does not decide capital. It decides whether Torghut
is allowed to run bounded repair work that refills evidence projections.

Allowed refill classes:

- `empirical_job_refresh`
- `quant_latest_projection_refill`
- `market_context_refresh`
- `routeability_snapshot_refresh`
- `tca_projection_refresh`

Blocked refill classes:

- Any live order submission.
- Any paper canary without a valid source/GitOps ref.
- Any job that would mutate Kubernetes or database state outside the owning service's normal repair workflow.
- Any refill not citing the active ingestion epoch.

## Implementation Scope

Jangar engineer owns:

- Add status types for `ControllerIngestionEpoch` and `ProfitEvidenceRefillGate`.
- Add a reducer under `services/jangar/src/server/` that builds ingestion epochs from controller heartbeat, rollout,
  database, watch reliability, and AgentRun ingestion state.
- Replace serving-local `agentrun_ingestion.unknown` with `repair_only` when a split controller heartbeat is fresh but
  no controller high-watermark is available.
- Extend source rollout truth, route stability escrow, material action verdict, and action clocks to consume the active
  ingestion epoch.
- Extend `buildScheduleRunnerCommand()` to require a stamped ingestion epoch when schedule admission checking is on.
- Add tests for healthy epoch, repair-only epoch, expired epoch, source/GitOps missing, split-controller heartbeat
  with local singleton disabled, and schedule-runner fire-time epoch mismatch.

Torghut engineer consumes:

- The active epoch ref in refill requests.
- The refill gate decision before refreshing empirical jobs or quant projections.
- The Jangar epoch ref in profit evidence receipts.

## Validation Gates

Minimum local validation:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/supporting-primitives-controller.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-source-rollout-truth-exchange.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-material-action-verdict.test.ts`
- `bunx oxfmt --check docs/agents/designs/158-jangar-controller-ingestion-epochs-and-profit-evidence-refill-gates-2026-05-07.md`

Runtime acceptance:

- Status shows a nonempty `controller_ingestion_epochs` array.
- Current observed state classifies as `repair_only`, not `unknown`, if source/GitOps is still missing.
- `dispatch_repair` remains held or bounded according to the epoch, while `serve_readonly` and `torghut_observe`
  remain allowed.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held
  or blocked until source/GitOps and controller high-watermark are current.
- Schedule runner fire-time logs cite `controller_ingestion_epoch_expired` or `controller_ingestion_epoch_mismatch`
  when the epoch is stale.

## Rollout Plan

1. Ship the reducer in shadow mode and expose it in status.
2. Compare the epoch decision to existing route stability and source rollout truth for one full schedule cycle.
3. Enable schedule-runner epoch stamping without enforcing mismatch rejection.
4. Enable fire-time rejection for expired or mismatched epochs.
5. Allow bounded `profit_evidence_refill` repair when the active epoch is `repair_only` and the requested refill class
   is in the allowed list.
6. Require a valid epoch for normal dispatch, merge readiness, and Torghut capital classes.

## Rollback

Rollback is configuration-first:

- Disable epoch enforcement while leaving epoch shadow output in status.
- Keep source rollout truth and route stability escrow as the active material gates.
- Disable profit-evidence refill admission and fall back to manual repair approval.
- Revert schedule-runner epoch mismatch rejection before reverting status output.

The rollback must not delete existing epoch records or hide evidence. Old epochs are audit artifacts and should be
allowed to expire naturally.

## Risks And Tradeoffs

- If controller high-watermarks are too strict, repair work may starve. Mitigation: allow repair-only refill for named
  evidence classes when database and watches are healthy.
- If epochs are too permissive, stale controller evidence could launch new work. Mitigation: fire-time schedule checks
  must compare stamped epoch to current epoch and fail closed on mismatch.
- If Torghut refill uses the gate as capital authority, it could bypass proof-floor controls. Mitigation: the gate only
  admits evidence refill, never capital.
- If source/GitOps revision remains unavailable, material actions continue to hold. That is intended.

## Handoff To Engineer And Deployer

Engineer acceptance:

- Implement `controller_ingestion_epochs` and `profit_evidence_refill_gate` in shadow mode.
- Add tests for split-controller healthy heartbeat plus serving-local ingestion unknown.
- Add schedule-runner fire-time epoch validation behind a feature flag.
- Publish status examples for `valid`, `repair_only`, `stale`, and `blocked`.

Deployer acceptance:

- Treat `active_controller_ingestion_epoch.status=valid` as required for normal dispatch, deploy widen, merge ready,
  paper canary, live micro canary, and live scale.
- Treat `repair_only` as enough only for bounded refill classes listed in this document.
- Keep live capital blocked unless Torghut proof floor, routeability, market context, alpha readiness, quant health,
  and Jangar ingestion epoch are all current.
- Roll back by disabling enforcement flags, not by deleting evidence.
