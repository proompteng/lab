# Jangar Control Plane Operability and Reliability Assessment (Discover Stage)

Status: In Review (2026-03-04)

## Executive summary

The control-plane read surface is healthy enough for baseline requests, and cache freshness signals already exist on core resource APIs, but operations are still blind to recurring schedule/job rollout failures. This stage captures evidence across cluster/source/database surfaces and records one prioritized design change: add a controlled rollout reliability envelope to the control-plane status API while keeping request-level fallback safety.

The chosen design surfaces burst and trend failure signals without adding new write paths, and keeps payload size and blast radius bounded.

## Assessment context

- Cluster scope: `jangar` control-plane-related workloads in namespace `agents`.
- Swarm scope: `jangar-control-plane` (`discover`, with `implement` and `verify` adjacent stages).
- Objective stage: `discover`.
- Base/branch: `main` → `codex/swarm-jangar-control-plane-discover`.

## Source assessment

### Current strengths

- Control-plane cache read paths are implemented in cache store and route handlers with freshness metadata.
- Route-level tests validate cache freshness and fallback semantics for `/api/agents/control-plane/resource`, `/api/agents/control-plane/resources`, and `/api/agents/control-plane/summary`.
- Control-plane status surface already emits controller/runtime/database/grpc/watch reliability fields.

### Source-based risk index (top)

- `services/jangar/src/server/control-plane-status.ts`
  - High: no explicit job rollout health summary (backoff count, active run count, top failure reasons).
  - Medium: `watch_reliability` aggregates watch behavior but does not map to schedule/job rollout operations used by operator triage.
- `services/jangar/src/server/control-plane-watch-reliability.ts`
  - Medium: good signal for stream health but separate from deployment/run failure diagnostics.
- `services/jangar/src/server/control-plane-cache.ts`
  - Low/medium: resilient fallback behavior avoids outages but can hide prolonged divergence without explicit rollout telemetry.

### Test coverage and gaps

Covered:

- Resource cache freshness + fallback in `resource`, `resources`, and `summary` routes.
- Control-plane status assembly with degraded component tracking.
- Watch reliability unit tests covering errors and restarts.

Gaps:

- No tests for rollout/job failure rollups or status surface health mapping.
- No end-to-end path test that combines Kubernetes rollout signals with status decomposition.

### Source proposal implication

- Keep control-plane status as the primary operator surface in discover stage.
- Add a bounded `status.workflows` block and explicit `degraded_components` entry (`workflows`) only when thresholds are crossed.

## Database/data assessment

### Data model quality

- `services/jangar/src/server/migrations/20260205_agents_control_plane_cache.ts` defines table `agents_control_plane.resources_current` with:
  - `last_seen_at` freshness timestamps.
  - namespace/kind/time indexes.
  - `deleted_at` filters for soft-deletion behavior.
- `services/jangar/src/server/db.ts` exposes typed contracts for that table.

### Freshness/consistency observations

- Freshness metadata is computed at read-time; there is no dedicated persisted schema for job rollout lag/trend, only resource cache state.
- Repeated operational failures do not currently persist as structured rollout telemetry in DB.
- As a result, operators have to combine status health with cluster events/logs to infer rollout drift.

### Data-quality posture

- Control-plane resource contract quality is good for current API responses.
- Rollout-operability quality is incomplete for this stage (no explicit historical failure trend persistence).

## Cluster assessment

### Rollout and health snapshot

Observed read-only signals:

- `kubectl -n agents get swarm jangar-control-plane -o yaml`:
  - swarm is `Active`, `Ready=True`.
  - requirements show queued/dispatched/pending activity and one blocked requirement.
  - recent 24h counts were observed (`missions24h=23`, `discoveries24h=3`).
  - `autonomousSuccessRate24h` was ~`0.0909`.
- `kubectl -n agents get jobs | rg jangar-control-plane` and `get events --field-selector reason=BackoffLimitExceeded` show recurring job-step failures in control-plane and torghut stages.
- `kubectl -n agents get cronjobs | rg jangar-control-plane` lists active cron schedules at 30m cadence.
- Direct `kubectl -n agents auth can-i` and operation probes show:
  - pod and service-account reads are possible.
  - deployments/crd/metrics reads remain RBAC-limited in this runner.

### Reliability signal interpretation

- Event backoff patterns are visible in cluster events and indicate repeated schedule/job execution churn.
- Control-plane status API currently does not include this failure rollup today.
- This is a reliable design target because it closes the visibility gap with minimum API change.

## Problem statement

The control plane can report controller/runtime/database status while this window still contains repeated schedule/job failures. This weakens operator confidence and extends mean-time-to-awareness.

## Design proposal

### Top design change (chosen)

Add a bounded `workflows` reliability block into `GET /api/agents/control-plane/status`:

- `status: healthy | degraded | unknown`
- `window_minutes` (configurable)
- `active_job_runs`
- `recent_failed_jobs`
- `backoff_limit_exceeded_jobs`
- `top_failure_reasons`

Implementation intent:

- Add a small adapter in `services/jangar/src/server/` that queries cluster jobs/events via the existing Kubernetes command execution path and returns deterministic counters.
- Degrade `status.runtime` (via `degraded_components`) when sustained threshold breaches are hit.
- Never fail status endpoint on adapter errors; emit `workflows.status=degraded` and include reason tags.

### Alternatives considered

- A) Keep status unchanged and rely on manual `kubectl get events`.
  - Low implementation risk, lower operator value.
  - Rejected because high mean-time-to-awareness and repeated triage friction.
- B) Add dedicated `/api/agents/control-plane/health` endpoint only.
  - Clean split but requires additional client/UI adoption and migration.
  - Deferred to follow-up stage.
- C) Add rollout metrics first, then status later.
  - Strong long-term analytics path.
  - Delays immediate discover usability for operators.
- D) Status-first envelope with deterministic workflow summary (chosen).
  - Fastest operator gain.
  - Minimal downstream surface change.
  - Safe migration path to metrics consumers.

### Design requirements for implementation

- Bounded payload and deterministic sort order.
- Status requests must remain queryable if Kubernetes queries fail.
- `status.runtime` and `namespaces[].degraded_components` should include `workflows` when reliability is degraded.
- Defaults to conservative thresholds and explicit environment variable overrides.

### Rollout plan (if/when implementation is added)

1. Add runtime adapter + status typing + unit tests.
2. Add or update status tests for degraded/unknown cases.
3. Extend docs and handoff runbooks with failure thresholds.
4. Add rollout verification check to this runbook family.
5. Move to plan stage with metrics-backed follow-up once this endpoint is stable.

## Handoff appendix

- Source of truth in this stage:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/control-plane-cache.ts`
  - `services/jangar/src/server/control-plane-watch-reliability.ts`
  - `services/jangar/src/server/control-plane-cache-store.ts`
  - `services/jangar/src/server/migrations/20260205_agents_control_plane_cache.ts`
  - `services/jangar/src/server/db.ts`
  - `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - `services/jangar/src/server/__tests__/control-plane-watch-reliability.test.ts`
  - `docs/agents/designs/jangar-control-plane-operability-reliability-assessment.md`

## PR and merge evidence (discover stage)

- A design-only discover PR will carry this decision and evidence for merge.
- Required follow-up checks are expected for changed files and repository CI profile.
