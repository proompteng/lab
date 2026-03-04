# Control Plane Summary Cache Freshness Design

Status: Approved (2026-03-04)

## Scope

This design extends the existing control-plane cache freshness contract to the control-plane summary endpoint (`/api/agents/control-plane/summary`) so operators get deterministic freshness signals on the same high-volume surface that drives the Jangar control-plane overview.

## Problem statement

The summary endpoint previously performed live `kubectl`/Kubernetes list operations for every primitive on every request. That created:

- repeated control-plane load with no visibility into stale index usage,
- longer tail latency when Kubernetes list operations are slow,
- no structured way to detect when aggregate counts are derived from stale cache rows,
- higher troubleshooting cost during partial cache lag.

A prior cache contract file already exists for resource/resources endpoints, but summary did not consume it.

## Design

### Implemented behavior

- Add optional cache support to summary route for cache-backed kinds:
  - `Agent`, `AgentRun`, `ImplementationSpec`, `ImplementationSource`
- Resolve cache freshness from `agents_control_plane.resources_current.last_seen_at` using:
  - `JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS`
  - `JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE`
- If cached rows are fresh (or stale reads are enabled), return summary totals (and phase counts for `AgentRun`) with an optional `cache` object:
  - `source`, `fresh`, `stale`, `age_seconds`, `max_age_seconds`, `as_of`, `checked_at`, `stale_count`, `oldest_age_seconds`
- If cached rows are stale and stale reads are disabled, explicitly fallback to Kubernetes live list.
- Cache is only instantiated when first needed and is closed once per request to keep behavior deterministic.

### Data contract changes

- `resources.<Kind>` may include a `cache` object when cache-backed data is returned.
- Existing `total` and `phases` fields remain unchanged for backward compatibility.

### Assessment evidence captured in this mission

- **Source review**:
  - Hot surface: `services/jangar/src/routes/api/agents/control-plane/summary.ts`
  - Related control-plane cache stack: `services/jangar/src/server/control-plane-cache.ts`, `services/jangar/src/server/control-plane-cache-store.ts`, `services/jangar/src/routes/api/agents/control-plane/resource.ts`, `services/jangar/src/routes/api/agents/control-plane/resources.ts`
  - Test coverage added in:
    - `services/jangar/src/server/__tests__/agents-control-plane-resource.test.ts`
    - `services/jangar/src/server/__tests__/agents-control-plane-resources.test.ts`

- **Database/state coupling**:
  - Cache reads are sourced from `agents_control_plane.resources_current`, which already stores `last_seen_at` and `resource_updated_at`.
  - Freshness computation uses `JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS` and `JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE`.
  - No new schema migration needed for this design change.

### Alternatives and tradeoffs

- A) Keep summary live-only (status quo).
  - Pro: no additional DB read path and no response-shape extension.
  - Con: no freshness signal, higher control-plane load during incidents.
- B) Add summary cache read + freshness metadata with strict fallback (chosen).
  - Pro: immediate reliability signal on aggregates, safe fallback behavior when stale.
  - Con: adds a small amount of schema-to-UI coupling and DB dependency on one more endpoint.
- C) Add separate freshness health endpoint and keep summary unchanged.
  - Pro: keeps summary schema completely stable.
  - Con: consumers still need multi-endpoint merge logic; not as immediate in triage.

### Database and source assessment notes

- `last_seen_at` exists in `agents_control_plane.resources_current` and powers staleness calculations without schema change.
- No per-kind freshness index exists for cache rows; freshness checks remain O(n) on returned result pages and acceptable for current summary volumes.
- The primary code risk remains cache synchronization completeness and watch reliability:
  - high-impact area: `services/jangar/src/server/control-plane-cache.ts`
  - query surface risk: `services/jangar/src/routes/api/agents/control-plane/summary.ts`
  - schema/data-consistency risk: `services/jangar/src/server/control-plane-cache-store.ts` and migration-backed table definitions.

### Validation plan

- Add regression tests for:
  - cache-backed aggregate response,
  - phase counts from cache,
  - stale rows forcing live fallback when `JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE=false`.

### Rollout

- Merge behind the existing cache feature flags already used by control-plane cache paths.
- Monitor summary endpoint cache hit rate, fallback rate, and stale count trends.
