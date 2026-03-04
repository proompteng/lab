# Control Plane Cache Freshness Contract

Status: Draft (2026-03-04)

Docs index: [README](../README.md)

## Current State

- `/api/agents/control-plane/resource` and `/api/agents/control-plane/resources` can read from `agents_control_plane.resources_current` when `JANGAR_CONTROL_PLANE_CACHE_ENABLED` is on.
- Cache responses currently return only the snapshot JSON document with no freshness metadata.
- If the database cache lags, operators cannot distinguish a stale hit from a current hit.
- Cache stale behavior is implicit; there is no explicit policy for when stale records should be rejected.

## Problem

- High-confidence control-plane operations (resource fetch/list) can return silently stale state.
- Incident triage is harder because API consumers see unexpected drift without signal.
- `agents_control_plane.resources_current` has no explicit freshness contract surfaced to HTTP clients, so clients cannot decide whether to accept cache data or force live reads.

## Goals

- Provide deterministic cache freshness metadata for GET/list control-plane routes.
- Keep cache as default read path while allowing strict deployments to require live reads.
- Ensure no change in default runtime behavior without explicit configuration.

## Design

- Add `services/jangar/src/server/control-plane-cache-freshness.ts` with:
  - cache window configuration via `JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS` (seconds),
  - stale-policy configuration via `JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE` (default `true`),
  - shared freshness evaluation helper and response serialization helper.
- Extend cache store reads to return timestamp metadata (`last_seen_at`, `updated_at`, `resource_updated_at`) with every resource row:
  - `services/jangar/src/server/control-plane-cache-store.ts`
- Update API handlers:
  - `/api/agents/control-plane/resource`:
    - return `cache` metadata when serving cached records;
    - if stale and strict mode disabled (`ALLOW_STALE=false`), fall back to Kubernetes live read.
  - `/api/agents/control-plane/resources`:
    - evaluate stale state per cached row;
    - return aggregate cache metadata (`stale_count`, `oldest_age_seconds`) when cached data is used;
    - if strict mode is disabled and any row is stale, fall back to live list.
- Add regression tests for cache freshness and strict fallback:
  - `services/jangar/src/server/__tests__/agents-control-plane-resource.test.ts`
  - `services/jangar/src/server/__tests__/agents-control-plane-resources.test.ts`

## Alternatives and tradeoffs

- A) Serve stale cache only (current behavior).  
  - Pro: no extra DB/Kubernetes roundtrips.  
  - Con: no freshness signal; stale drift remains invisible.
- B) Always serve cache with explicit metadata (chosen).  
  - Pro: preserves throughput, surfaces freshness risk, easy rollback via env toggle.  
  - Con: stale data still possible when `ALLOW_STALE=true`; requires consumers to use metadata.
- C) Always require live Kubernetes read when stale.  
  - Pro: strongest freshness guarantee.  
  - Con: higher control-plane API latency during watch lag/failures.
- D) Add a separate "cache refresh required" endpoint and two-phase reads.  
  - Pro: clear operator control.  
  - Con: extra API surface and client complexity.

## Source and migration considerations

- Database schema is unchanged; freshness uses existing `last_seen_at`.
- `services/jangar/src/server/migrations/20260205_agents_control_plane_cache.ts` already persists `last_seen_at` and can support this contract without migration.
- No generated file changes required.

## Risks

- Clients that expect untyped response shape might treat the additional `cache` field as unknown but should ignore it.
- Strict mode (`ALLOW_STALE=false`) can increase response latency if cache rows are behind.
- If cluster clocks are skewed, freshness age calculations may be noisy.

## Validation

- Confirm stale records include `cache.stale=true` and configured age thresholds in response payload.
- Verify `ALLOW_STALE=false` forces live reads when cached records are stale.
- Confirm list endpoint returns cache metadata and fallback to live list when configured.
- Confirm no production behavior change for default configuration except added metadata.

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth

- Control-plane API routes: `services/jangar/src/routes/api/agents/control-plane/resource.ts`, `services/jangar/src/routes/api/agents/control-plane/resources.ts`
- Cache store + freshness: `services/jangar/src/server/control-plane-cache-store.ts`, `services/jangar/src/server/control-plane-cache-freshness.ts`
- Tests: `services/jangar/src/server/__tests__/agents-control-plane-resource.test.ts`, `services/jangar/src/server/__tests__/agents-control-plane-resources.test.ts`

### Handoff notes

- Rollout path: merge into `main` and validate via standard CI checks.
- If freshness signaling is needed downstream, update UI or clients to read `cache.stale` and `cache.age_seconds`.
