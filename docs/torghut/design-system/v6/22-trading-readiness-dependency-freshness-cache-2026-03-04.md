# 22. Trading Readiness Dependency Freshness Cache (2026-03-04)

## Context

Torghut readiness probes have historically mixed fast liveness checks with repeated dependency checks from `/readyz` and `/trading/health`. The service has external dependency checks in the readiness path:

- Postgres ping (`_check_postgres`)
- ClickHouse HTTP `/` probe (`_check_clickhouse`)
- Alpaca account/accounting check (`_check_alpaca`)
- Optional schema/account-scope contract checks for `/readyz` (`_evaluate_database_contract`)

Cluster rollout evidence for `torghut-00042` shows repeated probe failures and unstable transitions (`Liveness probe failed` and `Readiness probe failed`), consistent with a heavy per-request readiness contract during startup or transient dependency jitter.

## Problem

The readiness handler currently executes all expensive dependency checks synchronously for each request. This increases tail-latency variance and amplifies transient dependency jitter into K8s/Knative readiness churn.

## Decision

Introduce a bounded TTL in-memory readiness dependency cache used by the shared readiness payload path.

1. Add configurable cache controls in `services/torghut/app/config.py`:
- `TRADING_READINESS_DEPENDENCY_CACHE_ENABLED`
- `TRADING_READINESS_DEPENDENCY_CACHE_TTL_SECONDS`

2. Add caching helper helpers in `services/torghut/app/main.py`:
- `_readiness_dependency_cache_key`
- `_readiness_dependency_checks`
- `_readiness_dependency_snapshot`

3. Keep the existing `/readyz` semantics for contract shape and status mapping while adding metadata under `dependencies.readiness_cache`:
- `cache_used`
- `cache_ttl_seconds`
- `checked_at`

4. Add regression tests in `services/torghut/tests/test_trading_api.py` for:
- cache hit (single invocation across repeated `/readyz` calls)
- stale refresh (forced cache age beyond TTL triggers new dependency checks)

## Alternatives Considered

1. Keep current synchronous checks (status quo)
- Pros: behavior is straightforward and always freshest.
- Cons: unchanged probe churn and no suppression of transient dependency flaps.

2. Reduce dependency timeouts only
- Pros: easier and smaller diff.
- Cons: still executes full dependency suite each probe and remains sensitive to traffic bursts.

3. Cache dependency checks with bounded TTL (selected)
- Pros: reduces readiness-probe amplification, adds deterministic freshness metadata, keeps fail-closed behavior when stale checks degrade.
- Cons: introduces up to TTL of stale readiness reporting and requires cache-control tuning.

## Tradeoffs and Risks

- Freshness vs stability: TTL smoothing can delay detection of newly introduced dependency issues by up to configured TTL.
- Memory scope: cache is process-local and resets on pod restart, which is acceptable for transient probe behavior.
- Observability: cache metadata in payload allows operators to reason about health sample age, but existing clients must ignore the new field.

## Verification Matrix

- `services/torghut/tests/test_trading_api.py::TestTradingApi::test_readyz_reuses_dependency_checks_within_cache_ttl`
  - validates cache hit behavior and `dependencies.readiness_cache.cache_used`.
- `services/torghut/tests/test_trading_api.py::TestTradingApi::test_readyz_refreshes_dependency_checks_after_cache_ttl`
  - validates cache expiry path and refreshed dependency evaluation.
- Existing checks for `/readyz` success/failure paths continue to exercise dependency contract behavior for both schema and account-scope checks.

## Rollback Plan

- Disable caching with `TRADING_READINESS_DEPENDENCY_CACHE_ENABLED=false` and keep schema checks in place.
- If needed, set `TRADING_READINESS_DEPENDENCY_CACHE_TTL_SECONDS=0` to force synchronous checks while keeping rollout changes unchanged.
