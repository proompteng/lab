# Jangar Control Plane Operability and Reliability Assessment (Plan Stage)

Status: Proposed (2026-03-04) — queue refresh probe executed on 2026-03-04T10:44:55Z

## Summary

Current control-plane status reporting confirms component-level health for controllers, runtime adapters, database connectivity, and workflow backoff behavior, but it does not provide actionable rollout-stage health signals from schedule CRDs and jobs. This plan-stage design adds a dedicated `rollout` reliability surface under `/api/agents/control-plane/status` to expose stage health, staleness, and last-run freshness for `jangar-control-plane` and related swarms, while keeping availability-safe fallback behavior.

## Cluster Assessment

Read-only cluster inspection confirms mixed rollout health:

- `kubectl -n agents get schedules.schedules.proompteng.ai -l swarm.proompteng.ai/name=jangar-control-plane -o wide` shows all stages (`discover`, `implement`, `plan`, `verify`) in `Active` phase.
- `kubectl get cronjob -n agents -l swarm.proompteng.ai/name=jangar-control-plane -o wide` shows expected cronjobs for all four stages, updated in the last cycle with no suspended cron objects.
- `kubectl get jobs --all-namespaces` filtered by `jangar-control-plane-.*sched` shows both completed and running step jobs across stages.
- `kubectl get events -n agents` filtered for `BackoffLimitExceeded` shows repeated failures in implement-stage jobs, including `jangar-control-plane-implement-sched-xbm45-step-1-attempt-1` and related `torghut-quant` step jobs.
- Health signal quality gap: while schedule CRDs and cron jobs remain visible, rollout failures and stale schedule execution are only surfaced via ad-hoc log/event inspection, not in status output used by operators.

## Source Assessment

### Current strengths

- `services/jangar/src/server/control-plane-status.ts` already has resilient component reliability primitives and deterministic degrade markers.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts` covers workflow and database fallback cases and is straightforward to extend with rollout fixtures.
- Route-level summary surfaces and cache read/write paths already include timestamps and stale/freshness metadata.

### High-risk modules and maintainability notes

- `services/jangar/src/server/control-plane-status.ts` is the highest-impact path; additions here must preserve unknown/healthy fallback behavior since this API is part of operator UX.
- `services/jangar/src/server/supporting-primitives-controller.ts` and `services/jangar/src/server/control-plane-cache.ts` drive schedule/job execution but are weakly observable from the status contract.
- `services/jangar/src/server/db.ts` and migrations expose raw cache state but no dedicated rollout-history trend table, increasing observability lag during recurrent step backoff.

### Test coverage gaps

- Existing tests do not cover rollout/schedule health cross-linking between `Schedule` and owning `CronJob` resource states.
- No unit/integration test covers missing `CronJob` object resilience when schedule objects are present.
- Existing suite does not assert how stale/active/healthy rollup degrades namespace-level `degraded_components`.

## Database/Data Assessment

### Data model quality

- `services/jangar/src/server/migrations/20260205_agents_control_plane_cache.ts` and `services/jangar/src/server/db.ts` define `agents_control_plane.resources_current` with indexes for namespace/name/time, sufficient for cache health decisions but narrow in schema.
- Control-plane status consumers currently read raw resource states; rollout health requires joining latest schedule (`schedules.schedules.proompteng.ai`) and cron (`CronJob`) records at request time.

### Freshness/consistency

- `last_seen_at`, `created_at`, and `updated_at` exist in cache schemas, but there is no explicit historical SLA health metric table for rollout staleness or consecutive failures by stage.
- On this read-only pass, no cache corruption pattern was observed at the control-plane DB layer, but rollout quality is under-modeled as status aggregation logic.

### Consistency and quality risks

- Schedule-to-job reconciliation is dynamic and cross-resource; if status queries fail, API must degrade gracefully rather than fail.
- Without rollout rollup, repeated failures can exist while top-level controllers continue reporting healthy.

## Design Proposal

### Problem statement

Operators can see cache/readiness and workflows but lack a normalized, always-available rollout reliability signal for swarm stage schedules. This hinders rapid triage when a stage’s latest run is old, failed, or absent while controllers remain healthy.

### Top design change (selected)

Extend control-plane status with a new `rollout` surface in `services/jangar/src/server/control-plane-status.ts` and types in `services/jangar/src/data/agents-control-plane.ts`.

### Concrete shape

- `rollout.status`: `healthy | degraded | unknown`
- `rollout.window_minutes`: rolling evaluation window (configurable)
- `rollout.observed_schedules`
- `rollout.inactive_schedules`
- `rollout.stale_schedules`
- `rollout.stages[]` (per matched schedule):
  - `name`, `namespace`, `swarm`, `stage`, `phase`, `last_run_at`, `last_successful_run_at`, `last_transition_at`, `is_active`, `is_stale`, `reasons`
- Add `rollout` to namespace degraded component list when `rollout.status === 'degraded'`.

### Configuration and behavior

- Monitor swarms from env:
  - `JANGAR_CONTROL_PLANE_ROLLOUT_MONITORS` (preferred)
  - `JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_SWARMS` (fallback)
  - `JANGAR_CONTROL_PLANE_WORKFLOW_SWARMS` (legacy fallback)
- Window:
  - `JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_WINDOW_MINUTES` (default `120`)
- Failure mode:
  - Any Kubernetes/API error for rollout evaluation sets `rollout.status: unknown` and continues returning the rest of status payload.

### Alternatives considered

- Alternative A: keep current behavior unchanged.
  - Lowest implementation risk, highest MTTR during rollout degradations.
- Alternative B: add a separate `/api/agents/control-plane/rollout` endpoint only.
  - Better separation, but requires new consumer logic and leaves existing operators blind in established status views.
- Alternative C: add metrics pipelines first, then status surface.
  - Strong long-term observability path, but no immediate operational visibility in existing tools.
- Selected: selected design A+B hybrid: maintain existing status contract while adding rollout rollup to prevent silent degradation and avoid endpoint churn.

### Implementation evidence

- `services/jangar/src/server/control-plane-status.ts`
  - Added rollout reliability aggregator and scheduling merge logic.
  - Added rollout state to namespace degraded component set and output contract.
- `services/jangar/src/data/agents-control-plane.ts`
  - Added `ControlPlaneRolloutReliability` and `ControlPlaneRolloutStageReliability` types.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - Added/updated tests for stale rollout schedules and happy-path rollout data.

## Risks and tradeoffs

- Heavily coupled to naming/labels (`swarm.proompteng.ai/stage` and schedule name conventions); stale metadata can occur when operators change those contracts.
- Cross-resource correlation can under-report near boundary events (short-lived status transitions) depending on cron timing and API propagation.
- Additional payload size remains bounded and request-safe, but still introduces one new contract dependency for API clients.

## Rollout and validation plan

1. Merge rollout reliability type and status aggregation changes with fallback-safe default (`unknown`) when Kubernetes queries fail.
2. Expand tests around stale schedules and degraded-state propagation into `namespaces[0].degraded_components`.
3. Merge plan-stage PR only after CI checks and cluster/owner checks in the same channel context are green.

## Handoff appendix

- Primary implementation files:
  - `services/jangar/src/data/agents-control-plane.ts`
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/__tests__/control-plane-status.test.ts`
