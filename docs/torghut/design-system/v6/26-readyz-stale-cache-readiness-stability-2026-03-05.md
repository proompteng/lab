# ADR-026: /readyz stale-cache tolerance for rollout stability

## Summary

This ADR documents a readiness-plane improvement for `torghut` that keeps `/readyz` probe responses stable when dependency checks are healthy-but-late, without weakening overall production readiness controls.

- Status: Approved for discover-stage implementation
- Date: 2026-03-05
- Swarm: torghut-quant (discover)
- Owner: architector
- Related issue: `swarm-torghut-quant-discover`

## Problem

`/readyz` currently re-evaluates dependency checks whenever cache TTL has expired. The endpoint includes:

- PostgreSQL connectivity check
- ClickHouse health probe
- Alpaca account endpoint check
- Database schema/account-scope contract check

Even with cache enabled (`TRADING_READINESS_DEPENDENCY_CACHE_TTL_SECONDS=8`), probe-driven traffic can still become sensitive to transient dependency latency:

- Kubernetes probe timeout is ~1 second in rollout manifests.
- A valid dependency state can become stale just after TTL expiry and force full re-checks.
- Transient or delayed responses can mark readiness degraded even when state is recoverably stable.

This produces false-negative flaps and extends startup/redeployment loops.

## Design options considered

### Option A (status quo)

- Keep strict `/readyz` checks as-is.
- Pros: strongest freshness guarantees.
- Cons: higher sensitivity to short transient latency at probe cadence.

### Option B (selected)

- Add bounded stale-cache acceptance on `/readyz` only:
  - add `TRADING_READINESS_DEPENDENCY_CACHE_STALE_TOLERANCE_SECONDS`.
  - when cache age is beyond TTL but within TTL + tolerance, return the cached state and mark it as stale.
  - expose `cache_stale` + `cache_age_seconds` in payload.
  - keep `/trading/health` on strict behavior (no stale acceptance).
- Pros: improves rollout probe stability while preserving non-probe enforcement surface.
- Cons: `/readyz` may report slightly stale signals for the tolerance window.

### Option C

- Increase probe timeouts in Knative/Service manifest to fully avoid false negatives.
- Pros: improves signal freshness window.
- Cons: changes control plane behavior more broadly and can slow failure detection globally.

### Option D

- Remove database checks from `/readyz` and keep only lightweight health checks.
- Pros: maximum readiness liveness.
- Cons: reduces deployment guardrails for schema drift and account-scope invariants.

## Decision

Select Option B.

`/readyz` is for rollout readiness and has a distinct SLO from `/trading/health`, which remains strict and includes full synchronous evaluation. The selected option balances rollout stability with safety by making freshness degradations explicit in the payload.

## Implementation changes

1. Add `TRADING_READINESS_DEPENDENCY_CACHE_STALE_TOLERANCE_SECONDS` to settings with default `20`.
2. Extend readiness dependency snapshot logic to permit stale-cache reuse when:
   - cache is older than TTL,
   - within TTL + tolerance window,
   - endpoint is `/readyz` (`allow_stale_dependency_cache=True`).
3. Include `readiness_cache.cache_stale`, `cache_age_seconds`, and tolerance in `/readyz` payload.
4. Keep `/trading/health` using strict snapshot behavior.

## Test plan and evidence

- Add regression tests:
  - `/readyz` reuses stale cache inside tolerance and emits `cache_stale=true`.
  - `/readyz` refreshes after hard TTL when stale exceeds tolerance.
  - `/trading/health` remains strict and refreshes stale cache immediately.

## Risks and mitigations

- Risk: readiness could stay green briefly while dependency state changed.
  - Mitigation: tolerance is bounded and explicitly visible in payload.
  - Mitigation: `/trading/health` still validates synchronously and will surface degradation.
- Risk: operational confusion around cache age fields in observability dashboards.
  - Mitigation: include concrete fields in contract and update runbook references if needed.
