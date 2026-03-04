# Jangar Control Plane Operability and Reliability Assessment

Status: Implemented (2026-03-04)

## Executive summary

The control-plane read surface is generally healthy for component-level observability, but stale cache fallbacks were previously opaque during incident triage. This discover-stage design and implementation adds explicit cache-fallback provenance to resource endpoints so operators can distinguish live replacement reads from stale cache snapshots without changing endpoint contracts.

## Assessment context

- Cluster scope: `jangar` control-plane in `agents` namespace.
- Swarm scope: `jangar-control-plane`.
- Stage: `discover`.

## Cluster assessment

- `kubectl get swarm jangar-control-plane -o yaml` reports stage entries (`discover`, `implement`, `plan`, `verify`) active and `RequirementsBridge` blocked with queued requirement count.
- `kubectl get schedules.schedules.proompteng.ai -n agents -l swarm.proompteng.ai/name=jangar-control-plane -o wide` shows all discovery/implement/plan/verify schedules active.
- Job history shows repeated `BackoffLimitExceeded` on implement schedules and periodic successful runs on other stages.
- `BackoffLimitExceeded` evidence remains in Kubernetes events rather than control-plane status payload, so a secondary interpretation path is still needed for rollout health.

## Source assessment

### Current strengths

- Route handlers in `services/jangar/src/routes/api/agents/control-plane/resource.ts` and `resources.ts` already support cache-first reads and fallback-to-live behavior.
- Fallback and freshness handling is centralized in dedicated helper modules under `services/jangar/src/server`.

### High-risk modules

- `services/jangar/src/routes/api/agents/control-plane/resource.ts` and `services/jangar/src/routes/api/agents/control-plane/resources.ts`.
  - These routes are visible to operators and therefore must preserve backward compatibility while improving provenance.
- `services/jangar/src/server/control-plane-cache-store.ts` and migrations.
  - Snapshot-based cache can be stale; fallback transitions should remain observable.

### Test coverage and gaps

- New regression coverage for stale-cache fallback provenance now exists in:
  - `services/jangar/src/server/__tests__/agents-control-plane-resource.test.ts`
  - `services/jangar/src/server/__tests__/agents-control-plane-resources.test.ts`
- Remaining gaps:
  - No system-level coverage for stream mode with stale cache and fallback path simultaneously.
  - No dedicated rollout/job health contract in status endpoint in this PR (tracked as follow-up). 

## Database/data assessment

### Data model quality

- Cache schema remains `agents_control_plane.resources_current` in `services/jangar/src/server/migrations/20260205_agents_control_plane_cache.ts` with indexed `(cluster, kind, namespace, name)` and timestamp fields for freshness decisions.
- Read-path mapping in `services/jangar/src/server/db.ts` remains strongly typed and supports freshness computation.

### Freshness/consistency

- Freshness metadata is computed from `last_seen_at` and request-time in `control-plane-cache-freshness` helpers.
- This PR preserves existing freshness metadata and adds provenance only on fallback transitions.

### Data-quality observations

- Snapshot cache remains a denormalized optimization layer, not the source of truth.
- Observability of schedule/job drift and rollout health remains external to this cache model.

## Design proposal

### Problem statement

Fallback reads were previously represented as cache-free response paths even when the request path had just used cache staleness logic. This removed useful context exactly when staleness becomes a risk.

### Top design change (chosen)

Emit structured fallback provenance on the existing cache-aware endpoints:
- `GET /api/agents/control-plane/resource/{kind}/{name}`
- `GET /api/agents/control-plane/resources?kind=...`

When a stale cache row triggers live fallback (`allowStale=false`), include:
- `cache.source = 'control-plane-cache'`
- `cache.fresh`, `cache.stale`, `cache.age_seconds`, `cache.max_age_seconds`
- `cache.cache_fallback` with `reason` and `replacement`

### Alternatives considered

- Keep current behavior and return cache metadata without fallback provenance (lowest change, least operator clarity).
- Add a dedicated fallback diagnostics endpoint (cleaner contract, extra endpoint adoption cost).
- Add warning text only in an unstructured message field (insufficient for automation).

Selected approach: retain endpoint compatibility and add structured `cache_fallback` only when needed.

### Implementation evidence

- `services/jangar/src/routes/api/agents/control-plane/resource.ts`
  - Added `cache_fallback` metadata on stale-cache fallback single-resource reads.
- `services/jangar/src/routes/api/agents/control-plane/resources.ts`
  - Added shared cache response builder and list-level fallback provenance.
- `services/jangar/src/server/__tests__/agents-control-plane-resource.test.ts`
  - Added regression assertion for fallback payload.
- `services/jangar/src/server/__tests__/agents-control-plane-resources.test.ts`
  - Added regression assertion for fallback payload.

## Risks

- Consumer impact is additive, but clients that assumed `cache` absent during fallback paths may require parser updates.
- Remaining rollout/job observability gap remains to be solved in a follow-up control-plane status design.

## Rollout and validation

- Merge this change as the discover-stage deliverable.
- Track the broader rollout reliability envelope as follow-up work in control-plane status design docs.

## Handoff appendix

- Source of truth in this stage:
  - `services/jangar/src/routes/api/agents/control-plane/resource.ts`
  - `services/jangar/src/routes/api/agents/control-plane/resources.ts`
  - `services/jangar/src/server/__tests__/agents-control-plane-resource.test.ts`
  - `services/jangar/src/server/__tests__/agents-control-plane-resources.test.ts`
