# 17. Trading Readiness and Rollout Stability Through Dependency-aware `/readyz` (2026-03-04)

## Context

- Rollout events observed repeated readiness/liveness instability on `torghut` pods:
  - `Readiness probe failed: ...:8012/` timeouts.
  - `Liveness probe failed: GET ...:8181/healthz` connection-refused.
- The service already exposes a dependency-aware `/trading/health` endpoint but Knative routes both liveness and readiness probes to `/healthz`, which only returns static `{"status":"ok","service":"torghut"}`.
- Source and architecture review also found duplicated allocator configuration aliases in `services/torghut/app/config.py`, a future maintainability hazard that is noted for later cleanup.

## Design Decision

Introduce `/readyz` as a reusable, dependency-aware readiness contract and map Knative `readinessProbe` to this endpoint while keeping `/healthz` unchanged for liveness.

### Implementation

1. Add shared helper:
  - `services/torghut/app/main.py: _evaluate_trading_health_payload(session)`
  - Centralizes scheduler/dependency evaluation currently in `/trading/health`.
2. Add endpoint:
  - `GET /readyz` (same payload and 503/200 status behavior as `/trading/health`).
3. Update Knative readiness probe:
  - `services/torghut/argocd/applications/torghut/knative-service.yaml`
  - `readinessProbe.httpGet.path: /readyz`.
4. Add regression tests:
  - `services/torghut/tests/test_trading_api.py`
  - covers `/readyz` success and dependency-failure behavior.

## Alternatives Considered

- **Option A (Selected): Add `/readyz` and keep `/healthz` unchanged**
  - Pros: minimal surface area, preserves existing liveness contract, reduces blast radius for rollouts.
  - Cons: `/trading/health` and `/readyz` remain duplicate outputs; can be merged later.
- **Option B: Promote `/trading/health` to readiness and drop `/readyz`**
  - Pros: zero new endpoint.
  - Cons: semantically couples public trading-health API with K8s probe contract and increases accidental API change risk.
- **Option C: Keep current probe target**
  - Pros: no manifest changes.
  - Cons: no improvement to readiness signal quality and no reduction in rollout flaps.

## Tradeoffs

- Readiness now depends on dependency checks (Postgres/ClickHouse/Alpaca + scheduler state), which is safer for rollout but can fail readiness under transient upstream outages.
- Liveness remains low-fidelity by design, so container restarts are still guarded by separate kubelet policies and do not depend on external systems.

## Acceptance Criteria

- Kubernetes readiness transitions to healthy only when `/readyz` returns 200.
- `/readyz` returns the same dependency status shape and status-code semantics currently used by `/trading/health`.
- Unit tests cover both healthy and degraded readiness conditions.

## Rollout Validation Note

- `/trading/health` now reports explicit Jangar freshness/readiness details under `dependencies.universe`.
- Readiness is expected to remain green when Jangar is degraded but recoverable (`status=degraded`, stale cache within `TRADING_UNIVERSE_MAX_STALE_SECONDS`) while still surfacing `ok=true` with `detail=jangar stale cache in use`.
- Readiness is expected to fail (`status=degraded`, `dependencies.universe.ok=false`) when Jangar is hard-failed or fail-safe blocked under `TRADING_UNIVERSE_REQUIRE_NON_EMPTY_JANGAR`.
- Any rollout check should include alerting on repeated transitions to `status=error` with `reason` suffix `_cache_stale`, not only on readiness flaps.

## Rollback Plan

- Revert only `argocd/applications/torghut/knative-service.yaml` readiness path to `/healthz`.
- Optionally keep `/readyz` endpoint and tests in place as a no-op diagnostic route if probe behavior must be stabilized quickly.
