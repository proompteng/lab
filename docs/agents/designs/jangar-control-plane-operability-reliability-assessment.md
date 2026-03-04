# Jangar Control Plane Operability and Reliability Assessment (Discover Follow-Up)

Status: Proposed (2026-03-04) — queue refresh probe executed on 2026-03-04T10:44:55Z

## Summary

Current control-plane status reporting confirms component-level health for controllers, runtime adapters, database connectivity, and workflow backoff behavior. A discover-stage follow-up design issue remains for the broader rollout-stage reliability surface, but this PR focuses on a narrower reliability gain: explicit provenance for control-plane resource cache fallback reads so operators can distinguish stale-cache responses from live reads during incident triage.

Discover follow-up adds explicit cache fallback provenance for control-plane resource endpoints so operators can distinguish cached responses from fallback live reads when stale cache rows are rejected.

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
- Route-level summary surfaces and cache read/write paths already include timestamps and stale/freshness metadata that can be extended with provenance.

### High-risk modules and maintainability notes

- `services/jangar/src/server/control-plane-cache.ts` and `services/jangar/src/routes/api/agents/control-plane/*.ts` are the highest-impact paths for this change.
  - A fallback policy bug can silently degrade operator confidence if cache freshness semantics are not surfaced.
  - Maintainability concern: the routes currently set `cache` to undefined for fallback paths, discarding useful freshness context.
- `services/jangar/src/server/supporting-primitives-controller.ts` and cache store writes are coupled through event/watch timing; stale-cache windows can become indistinguishable from successful live reads.
- `services/jangar/src/server/db.ts` + migrations define a compact cache model but no first-class schema for fallback/rollback provenance.

### Test coverage gaps

- Existing tests did not cover cache-stale fallback provenance.
- Existing tests did not assert a stable payload contract when stale cache rows are rejected and `allowStale=false`.
- Existing suite does not cross-check stale cache behavior with resource-stream mode.

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

Operators can currently receive stale cache snapshots without a clear indicator that a live read replaced the response. This produces ambiguity in incident handling, especially during implement-stage backoff churn and when cache freshness thresholds are exceeded.

### Top design change (selected)

Add explicit cache fallback provenance to control-plane resource endpoints:
- `GET /api/agents/control-plane/resources?kind=...`
- `GET /api/agents/control-plane/resource/{kind}/{name}?namespace=...`

The API now returns `cache` metadata and, when applicable, `cache_fallback` details describing why fallback occurred and what replacement path was used.

### Concrete shape

- `cache` fields on live response:
  - `source: 'control-plane-cache'`
  - `stale`, `fresh`, `age_seconds`, `max_age_seconds`
  - `cache_fallback` (present only on fallback):
    - `source: 'control-plane-cache'`
    - `reason`: machine-readable explanation (e.g. `stale_cache_fallback_disabled`)
    - `replacement`: fallback path description (e.g. `live-read`)

### Configuration and behavior

- Existing cache controls govern behavior:
  - `JANGAR_CONTROL_PLANE_CACHE_ENABLED`
  - `JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE`
  - `JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS`
  - `JANGAR_CONTROL_PLANE_CACHE_STALE_BUFFER_SECONDS`
- On stale cache detection with `allowStale=false`, handlers continue fallback to Kubernetes as now, but now annotate `cache_fallback` in the response.
- On fallback errors, existing behavior remains unchanged: route returns live read errors if both cache and API reads fail.

### Alternatives considered

- Alternative A: keep current behavior unchanged.
  - Lowest implementation cost, but ambiguity remains during stale-cache fallback events.
- Alternative B: add a separate diagnostic endpoint for cache-fallback details.
  - Cleaner contract, but operator tooling must learn a new endpoint and existing dashboards remain partially blind.
- Alternative C: include raw warning text only in `message` with no structured metadata.
  - Minimal schema change, but loses machine-usable indicators and prevents reliable alerting.
- Selected: keep existing routes and data model, add structured `cache_fallback` metadata only in fallback responses. Low risk, immediate value, and keeps clients backward compatible.

### Implementation evidence

- `services/jangar/src/routes/api/agents/control-plane/resources.ts`
  - Added shared `buildCacheResponse` and fallback metadata capture for list endpoints.
- `services/jangar/src/routes/api/agents/control-plane/resource.ts`
  - Added shared cache response builder and fallback provenance for single-resource lookups.
- `services/jangar/src/server/__tests__/agents-control-plane-resources.test.ts`
  - Added assertion for fallback provenance payload on stale cache paths.
- `services/jangar/src/server/__tests__/agents-control-plane-resource.test.ts`
  - Added assertion for fallback provenance payload when stale cache is rejected.

### Future work

- Evaluate a companion rollout reliability status surface in `/api/agents/control-plane/status` for long-lived schedule/job visibility (tracked as follow-up design scope).

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
