# Jangar Control Plane Operability and Reliability Assessment (Plan Stage)

Status: Draft (2026-03-04)

## Executive summary

The control plane read surface is healthy enough for baseline requests, and cache freshness signals were already introduced on core resource APIs, but production operations are still blind to high-frequency failures in swarm job execution and cache-watch health. This assessment proposes a first-stage design change: extend operator-facing control-plane observability through a deterministic, low-cardinality reliability surface that unifies schedule/job status with existing control-plane status output.

## Assessment context

- Cluster scope: `jangar` control plane via `jangar` namespace in `agents`.
- Swarm scope: `jangar-control-plane`.
- Stage: `plan`.

## Source assessment

### Current strengths

- Control-plane cache read paths are implemented in cache store and route handlers with freshness metadata.
- Route-level tests validate cache freshness behavior and fallback semantics for `resource`, `resources`, and `summary` endpoints.
- Control-plane status surface already emits controller/runtime/database/grpc health fields.

### High-risk modules

- `services/jangar/src/server/control-plane-cache.ts`:
  - Watches resource objects and updates `agents_control_plane.resources_current`.
  - Failure modes are logged per object but do not expose aggregate health for operators.
- `services/jangar/src/server/control-plane-status.ts`:
  - Strong for component health, weak for job/workflow health and rollout impact.
- `services/jangar/src/server/control-plane-cache-store.ts` / migrations:
  - Handles upsert/listing and timestamp metadata, but no direct lag/error telemetry stream.

### Test coverage and gaps

- Covered:
  - Freshness + stale-read fallback logic for `/api/agents/control-plane/resource` and `/api/agents/control-plane/resources`.
  - Summary fallback paths with mixed cache/live data in `/api/agents/control-plane/summary`.
  - gRPC status socket reachability tests.
- Gaps:
  - No unit/integration coverage for cache-watch lag, watch restart frequency, or job backoff state.
  - No test covers control-plane status endpoint enrichment with job/failure rollup data.

### Source-based risk notes

- `startControlPlaneCache()` can silently recover from watch failures, reducing immediate crash risk but also removing high-signal telemetry for repeatable cache divergence.
- Existing route handlers avoid hard failures via fallback-to-live logic, which is robust for availability but can mask recurring staleness under backoff conditions.

## Database/data assessment

### Data model quality

- `services/jangar/src/server/migrations/20260205_agents_control_plane_cache.ts` defines:
  - schema `agents_control_plane.resources_current`
  - `last_seen_at` as `TIMESTAMPTZ NOT NULL DEFAULT now()`
  - source-of-truth indexes for by-kind/namespace/time and `deleted_at` filtering.
- `services/jangar/src/server/db.ts` exposes the same shape as a first-class typed table contract.

### Freshness/consistency

- Freshness metadata is computed at read time, with no dedicated DB field for stale threshold violations.
- The table does not persist structured lag/health deltas over time, so operators cannot trend drift without external scraping.
- Current query model (`listResources`) is optimized for namespace/kind retrieval with indexes, and supports fallback decisions based on timestamps.

### Data-quality observations

- Multiple job execution failures do not currently mutate cache state directly; observability is only implicit through log and Kubernetes events.
- Without explicit rollout/job health in control-plane status, cluster and data views are split: API health can be green while schedule steps show repeated backoff events.

## Problem statement

The control plane can report controller/runtime/database health while the same window contains multiple BackoffLimitExceeded job events and long-running failed schedule attempts. This prevents reliable maintenance decisions and delays incident triage.

Recent commands observed:

- `kubectl -n agents get jobs | wc -l` and job event output show repeated `BackoffLimitExceeded` entries.
- `kubectl -n agents get events --field-selector reason=BackoffLimitExceeded` shows multiple active swarm-related failures in the same control-plane time window.
- Swarm scheduling remains Active for all stages, but job-level execution health is not surfaced in `/api/agents/control-plane/status`.

## Design proposal

### Top design change (chosen)

Add a control-plane reliability envelope to status output, using existing cache and Kubernetes read paths:

- Introduce a small `workflows` block in `services/jangar/src/server/control-plane-status.ts`:
  - `active_job_runs`
  - `recent_failed_jobs`
  - `backoff_limit_exceeded_jobs`
  - `window_minutes` (configurable)
  - optional `top_failure_reasons`
- Add a lightweight adapter that queries jobs using the same service credentials as other control-plane operations and filters by:
  - label patterns used by schedule jobs for `jangar-control-plane` and optional `torghut-quant`
  - optional namespace scoping from `JANGAR_AGENTS_CONTROLLER_NAMESPACES`.
- Return `status.runtime` degraded if backoff counts exceed configured thresholds, but never fail control-plane requests.
- Keep defaults conservative (`window_minutes` default 15, warn at first repeated failure, degrade at sustained threshold).

### Alternatives considered

- A) Keep status endpoint unchanged and rely on manual `kubectl get events` inspection (current state).
  - Lowest risk and implementation cost.
  - Highest mean-time-to-awareness during sustained failures.
- B) Add a dedicated `/api/agents/control-plane/health` endpoint for job/reporting only.
  - Clear separation of concerns and less payload coupling.
  - Requires additional client changes and potential UI duplication.
- C) Add control-plane metrics first, then status reporting (hybrid).
  - Better long-term scalability and alerting, but no immediate operator visibility in current CLI/UI surfaces.
- Chosen approach: **A+B hybrid with status-first minimal payload**.
  - Immediate maintainability gain: same endpoint surfaces degraded rollup and failure patterns.
  - Minimal downstream impact and lower rollout risk than a brand-new endpoint.
  - Can be evolved later into dedicated metrics consumers.

### Design requirements

- Keep payload deterministic and capped.
- Do not fail `GET /api/agents/control-plane/status` if Kubernetes job list calls fail.
- Expose explicit `degraded_components` entry for `workflows` when threshold crossed.

### Rollout and validation

1. Design-only PR in `docs/agents/designs`.
2. If implemented in follow-up stage:
   - add config and tests for status adapter behavior;
   - add smoke check with one failing job pattern and one healthy pattern;
   - document remediation steps in handoff runbooks.

## Handoff appendix

- Source of truth in this stage:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/control-plane-cache.ts`
  - `services/jangar/src/server/control-plane-cache-store.ts`
  - `services/jangar/src/server/db.ts`
  - `services/jangar/src/server/migrations/20260205_agents_control_plane_cache.ts`
  - `services/jangar/src/server/__tests__/agents-control-plane-resource.test.ts`
  - `services/jangar/src/server/__tests__/agents-control-plane-resources.test.ts`
  - `services/jangar/src/server/__tests__/agents-control-plane-summary.test.ts`
  - `services/jangar/src/server/__tests__/control-plane-status.test.ts`
