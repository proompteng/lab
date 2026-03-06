# Jangar Control Plane Stage Outcome Confidence and Quota Resilience

Status: In Progress (2026-03-06)

## Summary

Current `jangar-control-plane` stage schedules can report `Active/Ready` while stage jobs fail with
`BackoffLimitExceeded`, and discover/plan/verify failures do not contribute to the existing swarm freeze trigger.
This proposal introduces a unified stage outcome confidence model and quota-aware failure policy so that control-plane
status reflects execution truth, not only schedule liveness.

## Implementation update (2026-03-06)

This iteration implements the highest-priority runtime slice: stop reporting workflow reliability as implicitly healthy
when Kubernetes workflow collection fails.

Shipped in this slice:

- `workflows.data_confidence` (`high|degraded|unknown`) in `/api/agents/control-plane/status`.
- Explicit workflow collection telemetry:
  - `workflows.collection_errors`
  - `workflows.collected_namespaces`
  - `workflows.target_namespaces`
  - `workflows.message`
- Namespace degradation wiring for workflow blind spots:
  - `workflows` is degraded when confidence is not `high`.
  - `runtime:workflows` is degraded when confidence is `unknown`.
- UI surfacing for workflow data confidence and collection coverage.
- Regression tests updated to require degraded status when workflow list lookup fails.

Remaining design slices from this document:

- Stage-level counters and confidence by discover/plan/implement/verify.
- Freeze trigger expansion from implement-only to all enabled stages.
- Quota/capacity-specific classification (`ModelCapacityExceeded`) and provider fallback policy metadata.

Rollback path for this slice:

- Revert the workflow confidence fields and namespace degradation wiring in:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/data/agents-control-plane.ts`
  - `services/jangar/src/components/agents-control-plane-status.tsx`
- Restore prior test expectations in `services/jangar/src/server/__tests__/control-plane-status.test.ts`.

## Assessment context

- Cluster scope: `agents` namespace, swarm `jangar-control-plane`.
- Stage scope: discover.
- Objective: improve maintainability and reliability through one design change that closes the highest current
  observability and control gap.

## Evidence

### Cluster evidence (read-only)

- `kubectl get schedules.schedules.proompteng.ai -n agents -l swarm.proompteng.ai/name=jangar-control-plane -o json`
  shows all four stages (`discover`, `plan`, `implement`, `verify`) with `phase=Active` and `Ready=True`.
- `kubectl get jobs -n agents -o json` filtered by `jangar-control-plane-*` shows:
  - `total=38`
  - `failed_total=24`
  - `failed_last_15m=3`
  - `backoff_last_15m=3`
- Job logs for `jangar-control-plane-plan-sched-2swhq-step-1-attempt-1` include:
  - `Stream error -> You've hit your usage limit for GPT-5.3-Codex-Spark.`
  - followed by job failure and `BackoffLimitExceeded`.
- `/api/agents/control-plane/status` currently returns:
  - `database.status=healthy` with `registered_count=21`, `applied_count=21`
  - `rollout_health.status=unknown` with message `rollout health unavailable (kubernetes query failed)`
  - `workflows.backoff_limit_exceeded_jobs=0` despite observable failed jobs in namespace.

### Source evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` computes freeze input from
  `implementRuns` only (`swarm.proompteng.ai/stage == 'implement'`) at lines ~1829-1831.
- `reconcileScheduleRunnerStatus` marks schedule readiness from CronJob schedule time, not outcome,
  and writes `Ready=True` at lines ~1567-1579.
- `services/jangar/src/server/control-plane-status.ts` catches workflow collection errors and still emits zeroed
  reliability counters (lines ~715-799, ~889-899), which can mask data-collection blind spots.
- Test coverage reinforces this behavior:
  `services/jangar/src/server/__tests__/control-plane-status.test.ts` includes
  `keeps control-plane status healthy when workflow list lookup fails` (around lines ~337-383).

### Database/data evidence

- Control-plane DB contract quality appears healthy from status route:
  - migration table `kysely_migration`
  - no unapplied or unexpected migrations
  - latency ~42ms during this run
- Direct SQL verification from this workload was blocked by namespace RBAC:
  - `pods/exec` forbidden in `jangar` namespace (`kubectl cnpg psql` denied)
- Net result: schema consistency is currently healthy by service-owned checks, but external verification path is
  restricted to API-level evidence for this agent identity.

## Problem statement

The control plane currently conflates schedule liveness with stage execution health. Operators can observe
`Active/Ready` schedules while stage jobs fail repeatedly due to model quota or runtime issues. The freeze policy is
implement-centric and does not directly protect discover/plan/verify degradation, which is exactly where design and
handoff reliability can drift.

## Top design change (chosen)

Introduce a stage outcome confidence envelope that feeds both status and freeze decisions:

1. Add per-stage execution counters to the swarm status model for a bounded time window:
   - `recent_failed_jobs`
   - `backoff_limit_exceeded_jobs`
   - `top_failure_reasons`
   - `data_confidence` (`high`, `degraded`, `unknown`)
2. Promote schedule readiness from "cron fired" to "cron fired and recent outcome healthy enough",
   while preserving backward compatibility with additive fields.
3. Extend freeze trigger input from implement-only to all enabled stages with stage-specific thresholds, including a
   dedicated quota/capacity class (`ModelCapacityExceeded`) that can trigger adaptive behavior.
4. Add provider fallback policy metadata in stage runtime parameters (ordered provider candidates and retry class)
   so discover/plan can degrade gracefully instead of repeatedly hard-failing on a single model lane.

## Alternatives considered

- Alternative A: Keep current status and rely on external job/event dashboards.
  - Pros: no contract or controller changes.
  - Cons: keeps split-brain diagnosis path and longer incident triage.
- Alternative B: Expand freeze logic only (all stages) but keep status payload unchanged.
  - Pros: smaller implementation.
  - Cons: still poor operator confidence because status remains optimistic during collection failures.
- Alternative C: Add a separate endpoint for stage outcome reliability.
  - Pros: clean separation and richer payload.
  - Cons: introduces another operator surface and client integration cost.
- Alternative D: Chosen approach, additive status envelope plus stage-aware freeze/fallback.
  - Pros: highest reliability gain with one coherent contract and minimal UX fragmentation.
  - Cons: moderate implementation complexity and more tests across controller/status layers.

## Tradeoffs

- More status fields increase payload and maintenance overhead.
- Stage-aware freeze may pause productive runs earlier if thresholds are too strict; requires careful defaults.
- Provider fallback improves continuity but introduces deterministic routing complexity and must preserve auditability.

## Proposed implementation slices

1. Data contract update in `services/jangar/src/data/agents-control-plane.ts`:
   add stage outcome confidence fields and confidence enum.
2. Status collector update in `services/jangar/src/server/control-plane-status.ts`:
   emit confidence downgrade when workflow collection fails instead of silent zero-as-healthy semantics.
3. Controller update in `services/jangar/src/server/supporting-primitives-controller.ts`:
   compute per-stage failure windows and unify freeze logic across enabled stages.
4. Runtime parameter extension in schedule template builder:
   carry fallback policy metadata and classify quota errors.
5. Test updates:
   - replace healthy-on-workflow-lookup-failure expectation with `unknown/degraded confidence`.
   - add regressions for discover/plan/verify failure-triggered freeze behavior.
   - add quota classification and fallback selection coverage.

## Risks

- Incorrect threshold defaults can increase false-positive freezes.
- Fallback model choice must avoid silent quality regressions; explicit reporting is required.
- RBAC limits may still constrain direct rollout queries, so confidence semantics must remain explicit.

## Validation plan

- Unit coverage for controller freeze logic and status confidence outcomes.
- API contract tests for additive status fields and compatibility.
- Read-only cluster validation:
  compare stage outcome counters vs `kubectl get jobs/events` for the same window.

## Handoff guidance

- Engineer: implement slices in order 1-5 above; keep fields additive and backward-compatible.
- Deployer: verify post-rollout that `workflows` and per-stage outcome counters reflect observed failures and that
  quota events no longer present as healthy schedule-only states.
