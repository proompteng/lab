# Jangar Control Plane Operability and Reliability Assessment (Discover Follow-Up)

Status: Proposed (2026-03-04) — queue refresh probe executed on 2026-03-04T11:24:00Z

## Summary

Current control-plane status reporting covers controllers, runtime adapters, database, and workflow health, but it does not currently expose actionable rollout-stage reliability for each stage schedule in a single, reliable, operator-facing view.

This plan adds a rollout surface to `/api/agents/control-plane/status` that surfaces stage-level activity, staleness, recent failure counts, and backoff pressure, while preserving graceful fallback behavior.

## Cluster Assessment

Read-only checks confirm mixed rollout status and recurring failure pressure:

- `kubectl get schedules.schedules.proompteng.ai -n agents -l 'swarm.proompteng.ai/name=jangar-control-plane'` shows all jangar stages in `Active` phase.
- `kubectl get cronjob -n agents` shows jangar-control-plane cronjobs for all four stages and a healthy schedule cadence.
- `kubectl get jobs -n agents --sort-by=.metadata.creationTimestamp` shows both completed and long-running step jobs across stages.
- `kubectl get events -n agents --field-selector reason=BackoffLimitExceeded` shows repeated implementation-stage pressure and explicit backoff breaches on `jangar-control-plane-implement-sched-xbm45-step-1-attempt-2`, `-abc-step-1-attempt-1`, and `-def-step-1-attempt-1`.
- `kubectl -n agents get cronjobs.batch | rg -n "jangar-control-plane-(discover|implement|plan|verify)-sched-cron"` shows all stages currently scheduling on cadence with successful completes in recent minutes.
- `kubectl -n agents get jobs.batch --sort-by=.metadata.creationTimestamp | rg -n "jangar-control-plane"` confirms mixed complete/running/failed attempts and active rollout jobs in all stages, which motivates active-job awareness in stale logic.

## Source Assessment

### Current strengths

- `services/jangar/src/server/control-plane-status.ts` already has robust component reliability primitives, stable status typing, and deterministic degraded propagation.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts` has existing workflow/db fallback coverage and is straightforward to extend.
- Route contract already carries namespace degraded markers to signal systemic impact upstream.

### High-risk modules and maintainability notes

- `services/jangar/src/server/control-plane-status.ts` is the primary integration path for status shaping and must retain unknown/healthy fallback guarantees.
- Rollout reliability is now coupled to naming/label conventions (`schedules.schedules.proompteng.ai`, schedule names, `CronJob` state) and must fail safely on partial telemetry.
- `services/jangar/src/server/db.ts` and migration registry are not currently designed as high-cardinality rollout-history analytics tables, so this change is best as a computed rollup.

### Test coverage gaps

- Pre-change test suite did not assert rollout stage aggregation between schedules and cron/jobs for stale-stage and backoff-threshold conditions.
- Before this change there was no direct test asserting namespace degraded component propagation for rollout health.

## Database/Data Assessment

### Data model quality

- `services/jangar/src/server/migrations/20260205_agents_control_plane_cache.ts` and `services/jangar/src/server/db.ts` define `agents_control_plane.resources_current` for control-plane cache freshness and controller state, but this table is not a replacement for rollout trend analytics.
- Rollout status here should remain request-time synthesized from Kubernetes object state, with explicit unknown fallback on API read failures.

### Freshness/consistency

- Cache tables and existing status timestamps give last-seen freshness, but no persistent per-stage failure run history table exists.
- New rollout fields use bounded rolling windows, which keeps freshness deterministic and avoids stale historical leakage.

### Consistency and quality risks

- Incomplete Kubernetes telemetry can produce temporary `unknown` rollout state even when cluster is otherwise healthy.
- Repeated `BackoffLimitExceeded` events are visible quickly in the 2xx/xx window, but short windows can miss older historical patterns that require broader retention and alerting.
- Existing DB/type tooling can produce large cross-module type noise in this workspace, so localized checks should avoid broad repo-wide TypeScript assumptions.

## Design Proposal

### Problem statement

Operators need reliable stage-level visibility into rollout failures and freshness without waiting for external event aggregation. Current status payloads provide component and workflow signals but do not summarize rollout-stage pressure and staleness in one bounded, deterministic surface.

### Top design change (selected)

Add rollout reliability reliability rollup directly into `/api/agents/control-plane/status` using request-time schedule/job/crontab correlation.

#### Concrete shape implemented

- `rollout.status`: `healthy | degraded | unknown`
- `rollout.window_minutes`
- `rollout.observed_schedules`, `rollout.inactive_schedules`, `rollout.stale_schedules`
- `rollout.backoff_limit_exceeded_jobs`
- `rollout.backoff_limit_exceeded_threshold`
- `rollout.stages[]` per matched schedule with:
  - `name`, `namespace`, `swarm`, `stage`, `phase`, `last_run_at`, `last_successful_run_at`, `last_transition_at`, `is_active`, `is_stale`, `recent_failed_jobs`, `backoff_limit_exceeded_jobs`, `reasons`

### Configuration and behavior

- Monitor swarms from env:
  - `JANGAR_CONTROL_PLANE_ROLLOUT_MONITORS` (preferred)
  - `JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_SWARMS`
  - `JANGAR_CONTROL_PLANE_WORKFLOW_SWARMS` (legacy fallback)
- Window:
  - `JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_WINDOW_MINUTES` (default `120`)
- Backoff threshold:
  - `JANGAR_CONTROL_PLANE_ROLLOUT_BACKOFF_DEGRADE_THRESHOLD` (default `2`)
- Error mode:
  - Kubernetes/API failures keep `rollout.status` as `unknown` and preserve rest of status payload so status endpoint remains available.

### Alternatives considered

- Alternative A: keep existing behavior unchanged.
  - Lowest implementation work, highest operational blind spot in recurring failures.
- Alternative B: add a separate `/api/agents/control-plane/rollout` endpoint only.
  - Cleaner contract boundary, but requires additional consumer adoption and misses operators relying on current status view.
- Alternative C: build a dedicated rollout-metrics pipeline first.
  - Better for deep trend analysis, but no immediate operator visibility in existing dashboards.
- Selected: design B-like extension inside existing status contract (in-place rollout surface) for immediate and safer operator impact.

### Implementation evidence

- `services/jangar/src/data/agents-control-plane.ts`
  - Added `ControlPlaneRolloutReliability` and `ControlPlaneRolloutStageReliability` fields.
- `services/jangar/src/server/control-plane-status.ts`
  - Added rollout evaluation over schedules + crons + jobs.
  - Added per-surface counters and thresholded degraded evaluation.
  - Added namespace degraded propagation when `rollout` is degraded.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - Added regression coverage for stale schedules and rollout backoff threshold exceedance.

### Tradeoffs

- Coupling to schedule naming and stage labels is intentional for now; stronger long-term decoupling may require explicit rollout metadata schema.
- Windowed rollup reduces query cost and complexity but misses out-of-window historical patterns.
- This adds one API contract dependency for clients, but is additive and backward-compatible by keeping existing fields intact.

## PR and Merge Evidence

- Mission artifacts were created/updated for this mission:
  - issueId: `5d847d206f698d45420fe7c9`
  - documentId: `078efe110af5267db0f11242`
  - channel message: `08b9f44589d2e713de427c95`
  - decision reply message: `af4046c22c1ddcbc8577b9eb` (reply to message `2bfcc3e48b1594bd766336dc`)
- PR artifact is now tracked via PR #4041.

## Risks

- Transient API failures can produce `rollout=unknown` even during healthy execution.
- Naming/label drift in schedule objects can undercount or mis-classify rollout stages.
- Backoff pressure thresholds require careful tuning to avoid false positives in low-volume windows.

## Handoff appendix

### Primary implementation files

- `services/jangar/src/data/agents-control-plane.ts`
- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`

### Suggested next actions

- Merge this PR if CI is green.
- Confirm rollout stage reliability visibility in the runtime control-plane status endpoint after deployment.
- Consider adding rollout telemetry persistence if trend analysis is required in phase 2.

### Handoffs

- Engineering handoff target: engineer + deployer.
- Owner handoff to proceed once merge commit is available.
