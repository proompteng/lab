# Jangar Control-Plane Rollout Failure-Window Observability (Implemented)

Status: Implemented (2026-03-05)

## Summary

Cluster incidents in `jangar-control-plane` show frequent step-job retries and BackoffLimitExceeded events while the control-plane status payload does not expose per-stage failure trends. This design adds a bounded failure-window view under the existing rollout reliability surface so operators can distinguish an active but degrading stage from a healthy one before failures become outages.

## Problem

`/api/agents/control-plane/status` already reports high-level rollout freshness (`Active`, staleness, last run times), but it does not include:

- count of failed rollout jobs in the last window,
- count of backoff-limit failures,
- dominant recent failure reasons by schedule.

That limits triage when a stage keeps failing with transient reasons while still reporting active/partially healthy state.

## Proposed design

Extend `ControlPlaneRolloutStageReliability` and its producer in `services/jangar/src/server/control-plane-status.ts` with three fields:

- `recent_failed_jobs`
- `backoff_limit_exceeded_jobs`
- `top_failure_reasons` (`reason`, `count`)

These fields are computed from Kubernetes `jobs` in the control-plane namespace for schedules matching names in the current stage list and filtered to the rollout observation window (currently 120m by default).

Contract mapping:

- Data type updates in `services/jangar/src/data/agents-control-plane.ts`
- Rollout aggregation updates in `services/jangar/src/server/control-plane-status.ts`
- Unit regression in `services/jangar/src/server/__tests__/control-plane-status.test.ts`

## Data and algorithm details

- Schedule list is collected from `schedules.schedules.proompteng.ai` and filtered by monitor swarms.
- CronJob health contributes existing freshness and transition fields as before.
- Job history is collected from `jobs` in the same namespace and limited to the configured rollout window.
- A schedule is linked to jobs by canonical job naming pattern: `<schedule>-step-<n>-attempt-<k>` with tolerant matching for existing prefixes.
- Failed jobs contribute to `failureReasons` using their failed condition reason (or `Failed` fallback).
- Reason map is sorted by descending count with deterministic lexical tie-break.

## Alternatives considered

- A) Keep rollout stage contract unchanged.
  - Pros: zero schema changes.
  - Cons: no actionable failure-trend signal, slower incident triage.
- B) Add a separate `/api/agents/control-plane/rollout` endpoint.
  - Pros: richer independent contract.
  - Cons: requires new client surface and loses current operator convenience.
- C) Add failed-run trend as additive fields in existing `rollout` payload (selected).
  - Pros: low migration risk, immediately available in existing status consumers.
  - Cons: increases contract size and name-matching coupling to schedule/job naming.

## Source and reliability risk assessment

### High-risk modules

- `services/jangar/src/server/control-plane-status.ts`:
  - Must remain defensive if Kubernetes list calls fail.
  - Must avoid false positives: failure counters are additive, while degraded/healthy stage decision remains based on active/stale criteria.
- `services/jangar/src/server/agentctl-grpc.ts` and status routes:
  - Any shape extension is additive but must remain binary-compatible for clients.
- `services/jangar/src/data/agents-control-plane.ts`:
  - Shared API contract for frontend and external consumers.

### Test coverage gaps and additions

- Added regression test for rollout failure-window metrics in `services/jangar/src/server/__tests__/control-plane-status.test.ts`.
- Added stage-level `top_failure_reasons` coverage in this mission’s rollout failure test (`services/jangar/src/server/__tests__/control-plane-status.test.ts`).
- Remaining gap: long-tail stability under mixed job-name formats and cross-namespace schedule fanout; recommend follow-up fuzz coverage if naming evolves.

## Rollout evidence

- Data contract updates landed in this cycle:
  - `services/jangar/src/data/agents-control-plane.ts` (rollout stage contract field alignment)
  - `services/jangar/src/server/control-plane-status.ts` (per-stage reason rollup)
  - `services/jangar/src/server/__tests__/control-plane-status.test.ts` (contract validation)

## Cluster assessment context for design choice

- Active swarm: `jangar-control-plane` in `Active` mode.
- All four rollout stages present as `Active` schedules.
- Multiple `BackoffLimitExceeded` events observed on `jangar-control-plane-implement-*` jobs in cluster event stream.
- Existing rollout schedule status alone does not expose per-stage failed-run reason concentration.

## Database/data assessment context

- `agents_control_plane.resources_current` migration exists and includes freshness fields (`last_seen_at`), but no stage-level failure history.
- Control-plane rollout reliability here is computed live from Kubernetes resources, consistent with existing reliability surfaces.
- Schema quality concern remains limited to source-level observability coupling:
  - no dedicated persistence of rollout failure reason trends by stage.

## Rollout plan

1. Implement additive contract + aggregation fields and keep unknown fallback semantics.
2. Add/extend server tests around reason windows and counts.
3. Run targeted status/JS checks.
4. Open PR and merge only when checks pass.
