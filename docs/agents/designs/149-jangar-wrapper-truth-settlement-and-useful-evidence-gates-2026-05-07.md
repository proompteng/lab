# Jangar wrapper truth settlement and useful evidence gates

Status: Accepted architecture direction
Date: 2026-05-07
Author: Victor Chen, Jangar Engineering
Related Torghut contract:
`docs/torghut/design-system/v6/153-torghut-useful-evidence-capital-escrow-and-provider-repair-gates-2026-05-07.md`

## Decision

I am choosing a wrapper-truth settlement layer for the next Jangar control-plane increment. Jangar will keep serving
available when the route, process, and controller heartbeats are healthy, but it will not treat a completed wrapper
CronJob, AgentRun, or rollout as useful execution evidence until the child run, database witness, source revision, and
consumer-visible outcome agree.

The practical change is to make every material action carry a `UsefulEvidenceReceipt` before it can widen. A wrapper
success can admit observe-only work. Dispatch, deploy widening, merge-ready, and Torghut capital actions need a settled
receipt with the actual child job status, persisted control-plane row, source revision, and consumer effect. A green
wrapper with a failed child becomes negative evidence, not a pass.

This builds on the existing action clocks, material-action verdicts, negative-evidence router, controller witness, and
watch reliability work. I am not replacing those layers. I am adding the missing settlement step between "the schedule
ran" and "the system learned something safe enough to act on."

## Evidence Captured

Read-only cluster evidence on 2026-05-07T14:05Z to 2026-05-07T14:12Z:

- `jangar` namespace: `deployment/jangar` was `1/1`, `deployment/bumba` was `1/1`, `deployment/symphony` was `1/1`,
  and `deployment/symphony-jangar` was `1/1` on image family `93f80673` or matching current images. The Jangar rollout
  produced one transient `/health` readiness failure during startup, then settled.
- `agents` namespace: `deployment/agents` was `1/1` and `deployment/agents-controllers` was `2/2`. The API and
  controller pods had recent transient readiness timeouts, and the API pod had two restarts about 57 minutes before the
  check.
- The hourly Jangar discover, plan, implement, and verify wrapper CronJobs had recent successful wrapper jobs after
  earlier 2026-05-07T03:50Z to 2026-05-07T04:35Z failures. That is a recovery signal, but not sufficient proof that
  each scheduled lane produced useful work.
- Torghut market-context child jobs were still failing while their wrapper CronJobs completed. Two failed provider
  probe logs reported `Missing repository metadata in event payload`. A fundamentals batch child timed out after 600
  seconds, then raised `TypeError: write() argument must be str, not bytes` while handling the timeout.

Read-only database evidence from `jangar-db` on 2026-05-07T14:09Z to 2026-05-07T14:11Z:

- `agents_control_plane.component_heartbeats` showed `orchestration-controller`, `supporting-controller`,
  `workflow-runtime`, and `agents-controller` as `healthy` leader heartbeats about 12 seconds old.
- `agents_control_plane.resources_current` held 321 live `AgentRun` projections, 24 `ImplementationSpec` projections,
  8 `Agent` projections, 6 `AgentProvider` projections, and 1 `VersionControlProvider` projection.
- `public.agent_runs` contained 342 `Succeeded`, 149 `Failed`, and 30 `Running` rows. A single status summary cannot
  distinguish failed first attempts that later recovered from still-open useful-evidence debt.
- `public.torghut_market_context_evidence` had zero rows. `public.torghut_market_context_runs` showed fundamentals
  `started` rows with the latest activity on 2026-05-06T13:44:12Z, and the latest news success on
  2026-05-06T19:43:09Z.
- `torghut_control_plane.quant_alerts` had fresh open critical `metrics_pipeline_lag_seconds` alerts updated around
  2026-05-07T14:11Z. A direct `quant_pipeline_health` latest-row query hit a 3 second statement timeout, which is
  itself a data-plane usability signal.
- `workflow_comms.agent_messages` had active general-channel ingestion, with latest `status` and `run-started` messages
  in the 2026-05-07T14:08Z to 2026-05-07T14:09Z window.

Source evidence:

- `services/jangar/src/server/control-plane-status.ts` already composes controller heartbeats, workflow reliability,
  rollout health, database status, action clocks, negative evidence, runtime admission, route stability, and material
  action verdicts.
- `services/jangar/src/server/control-plane-action-clock.ts` gates action classes such as `dispatch_normal`,
  `deploy_widen`, `merge_ready`, and `torghut_capital`, but it mostly consumes aggregated status, not settled wrapper
  versus child truth.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already models Torghut negative evidence
  inputs for readiness, market context, quant alerts, rollout ambiguity, and paper settlement. It needs a higher-quality
  input feed, not another parallel gate.
- `services/jangar/src/server/control-plane-watch-reliability.ts` records in-memory watch errors and restarts. It is
  useful for local process safety but does not produce a durable receipt that a deployer can use after a restart.
- `services/jangar/src/server/torghut-market-context.ts` exposes provider and ingestion health, but provider health is
  process-local and the durable evidence table is empty in the current database snapshot.

## Problem

The control plane can look healthy at the serving and wrapper layers while execution trust is weaker underneath. That
creates three failure modes.

First, a completed wrapper CronJob can hide a failed or timed-out child job. The cluster showed exactly that for
Torghut market-context provider work. This is not a cosmetic reporting issue; it changes whether Jangar should admit
normal dispatch, deploy widening, merge-ready, or capital-bearing Torghut actions.

Second, database evidence can be present but not useful for the action being considered. Heartbeats were current, but
market-context evidence rows were absent and some market-context run rows were stale or unfinished. Those are different
truth classes and should not be netted into a single green status.

Third, source-level gates are already numerous enough that adding another top-level status would increase ambiguity.
Jangar needs a settlement product that feeds the existing action-clock and material-verdict machinery, not another
dashboard badge.

## Options Considered

Option A: strengthen readiness probes and block on route health.

This would reduce false green serving status, but it misses the main failure. The Jangar route and controllers were
available during this assessment. The degraded evidence was in child execution, provider proof, and database usefulness.
If readiness carries all of that, we will either flap the UI or teach operators to ignore readiness.

Option B: extend the existing action clocks with more reason codes.

This is close, and it is the smallest code change. The weakness is that action clocks currently consume already-shaped
summaries. More reason codes do not prove whether a completed wrapper maps to a failed child, whether a DB row is fresh
enough for the consumer, or whether a source revision has the handler that produced the evidence.

Option C: add wrapper-truth settlement receipts and feed them into existing gates.

This is the selected direction. It preserves the current control-plane layers, gives engineers a concrete artifact to
test, and gives deployers a clear rollback surface. The tradeoff is one new projection and API surface. I accept that
cost because it removes a class of false positives across Jangar and Torghut instead of fixing one symptom.

## Architecture

Add a `UsefulEvidenceReceipt` projection with these required fields:

- `receipt_id`: deterministic hash of action class, source revision, wrapper identity, child identity, and consumer.
- `action_class`: one of `serve_readonly`, `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `torghut_observe`, `paper_canary`, `live_micro_canary`, or `live_scale`.
- `wrapper_ref`: CronJob, Job, AgentRun, workflow UID, or rollout object that started the work.
- `child_refs`: concrete child Jobs, pods, AgentRuns, provider jobs, or workflow steps expected to produce evidence.
- `source_ref`: Git SHA or image digest that owns the code path producing the evidence.
- `database_refs`: table names, primary keys, row timestamps, and freshness windows used as durable witnesses.
- `consumer_refs`: the UI, API, NATS channel, Torghut gate, or deployer gate that consumed the evidence.
- `settlement_state`: `settled`, `partial`, `contradicted`, `stale`, `missing`, or `timed_out`.
- `decision`: `allow`, `observe_only`, `repair_only`, `hold`, or `block`.
- `fresh_until`: timestamp after which the receipt cannot admit material action.
- `negative_evidence`: normalized reason codes to feed `control-plane-negative-evidence-router.ts`.
- `rollback_target`: concrete action to take if a later witness contradicts the receipt.

The settlement board computes receipts from four witnesses:

1. Wrapper witness: did the wrapper controller, CronJob, rollout, or AgentRun report terminal success?
2. Child witness: did each child job, pod, runtime step, provider run, or nested AgentRun report the required terminal
   state within the action window?
3. Database witness: did the expected durable row exist, and was its freshness and schema consistent with the source
   revision?
4. Consumer witness: did the intended consumer read the evidence and report an action-compatible outcome?

The action-clock integration is intentionally narrow. The settlement board writes negative evidence into the existing
router and adds settled receipt IDs to material-action verdict evidence refs. The verdict arbiter remains the place that
combines clocks, budgets, rollout health, database status, watch reliability, and Torghut debt.

## Admission Policy

`serve_readonly` can proceed on fresh route and heartbeat evidence even when wrapper-truth settlement is partial.

`dispatch_repair` can proceed on partial or contradicted receipts when the receipt identifies a bounded repair target,
sets `max_dispatches=1`, sets `max_notional=0`, and expires within 20 minutes.

`dispatch_normal` requires all wrapper, child, database, and consumer witnesses to be `settled` or explicitly waived by
a human-reviewed receipt. A completed wrapper with a failed child is `hold`.

`deploy_widen` requires settled rollout, database, and consumer witnesses for the target revision. A healthy current
deployment is not enough if the candidate revision has no useful evidence.

`merge_ready` requires settled source and CI receipts plus no contradicted deployment or database witness for the PR
scope.

`torghut_observe` can proceed with stale market-context evidence if no notional exposure is possible and the receipt is
marked observe-only.

`paper_canary`, `live_micro_canary`, and `live_scale` require Torghut useful-evidence receipts from the paired Torghut
contract. Missing evidence rows, open critical quant lag alerts, provider timeouts, or unpriced data cost hold capital.

## Implementation Scope

Engineer stage:

- Add a settlement module under `services/jangar/src/server/` that builds `UsefulEvidenceReceipt` values from
  Kubernetes Job/AgentRun state, `agents_control_plane.resources_current`, `public.agent_runs`,
  `workflow_comms.agent_messages`, and Torghut evidence tables.
- Persist receipts in a new migration with indexes on `action_class`, `settlement_state`, `fresh_until`,
  `wrapper_ref`, and `source_ref`.
- Extend `buildNegativeEvidenceRouterStatus` inputs with settled receipt summaries instead of raw wrapper-only status.
- Extend `buildMaterialActionVerdictEpoch` evidence refs with receipt IDs and add tests for wrapper-success plus
  child-failure, wrapper-failure plus child-success, stale database witness, and source revision mismatch.
- Add a read API for Jangar UI and deployer checks: `/api/agents/control-plane/useful-evidence`.

Deployer stage:

- Roll out in shadow mode first: write receipts, expose status, and do not block action classes.
- Enable repair-only gating for contradicted receipts after one full day of shadow receipts.
- Enable `dispatch_normal` and `deploy_widen` holds only after receipt latency, false-positive rate, and DB query
  latency are within the validation gates.
- Enable Torghut capital holds last, paired with the Torghut capital escrow contract.

## Validation Gates

- Unit coverage for receipt normalization, settlement decision ranking, negative-evidence conversion, and freshness
  expiry.
- Regression test where a wrapper CronJob is `Complete` while its child job is `Failed`; expected decision is `hold`
  for `dispatch_normal`, `deploy_widen`, and capital classes.
- Regression test where `public.torghut_market_context_evidence` is empty while a market-context wrapper reports
  success; expected Torghut capital decision is `repair_only` or `hold`.
- Integration test using fixture rows from `agents_control_plane.resources_current`, `public.agent_runs`, and
  `workflow_comms.agent_messages` to prove a settled receipt is deterministic.
- Database check: latest receipt query for a single action class must complete under 500 ms on production-sized data,
  with a statement timeout in CI to catch missing indexes.
- Rollout check: `/api/agents/control-plane/status` remains available when receipt DB reads fail; status degrades the
  relevant action classes but does not take down serving.

## Rollout And Rollback

Rollout sequence:

1. `observe`: write receipts and dashboard them. No gating.
2. `repair`: let contradicted receipts admit only bounded repair dispatch.
3. `normal-dispatch`: hold normal dispatch and deploy widening on contradicted or stale receipts.
4. `capital`: connect Torghut capital gates to useful-evidence receipts.

Rollback is a configuration rollback, not a schema rollback. Set the settlement mode back to `observe`, leave the table
and API in place, and stop feeding receipt-derived negative evidence into action clocks. If receipt writes overload the
database, disable writes and keep read-only status composition on the previous control-plane gates.

## Risks

- Receipt writes can become noisy if every pod event creates a row. The receipt key must be action-scoped and
  deterministic, and status changes should update the current receipt rather than append unbounded rows.
- A strict gate can slow useful repair work. That is why `dispatch_repair` stays available with bounded runtime and zero
  notional exposure.
- Missing RBAC can reduce direct cluster evidence. The production controller should use its existing watch/cache state
  first and only supplement with API reads it is already authorized to perform.
- The design depends on source revision binding. If image tags drift from Git SHAs, deployer checks must use digests and
  source manifests as the binding authority.

## Handoff Contract

Engineer acceptance:

- A green wrapper with a failed child produces a contradicted receipt and a blocking action-clock reason.
- Empty Torghut market-context evidence produces a capital hold while keeping observe-only work available.
- Receipt IDs are stable across process restarts for the same witnesses.
- Status APIs keep serving when receipt reads fail, and expose the failure as degraded useful-evidence status.

Deployer acceptance:

- Shadow receipt volume and query latency are measured before gating.
- `dispatch_normal`, `deploy_widen`, and Torghut capital gates are enabled in separate releases.
- Rollback to observe mode is tested before capital gating.
- The deployer posts receipt summaries in release evidence so the next engineer can see why an action was allowed,
  repaired, held, or blocked.
