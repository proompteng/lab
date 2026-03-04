# 19. Database Schema Contract in `/readyz` for Rollout Safety (2026-03-04)

## Context

- Cluster observations in `torghut` continue to show rollout churn with readiness/liveness instability on prior revisions, including `Readiness probe failed` and `Liveness probe failed` warnings, plus Knative warnings for revision endpoint updates and endpoint drift.
- Source inspection shows `/readyz` already checks Postgres/ClickHouse/Alpaca/scheduler state, but it does not gate on Alembic migration head freshness or account-scope isolation invariants.
- `/db-check` validates schema contracts in an endpoint, but rollout probes are decoupled from that contract, creating a gap where an outdated schema can still appear as ready.
- Existing tests cover DB contract via `/db-check`, but there are no rollout-readiness tests for schema/account-scope readiness regressions.

## Decision

Promote schema and account-scope contract checks into readiness evaluation by extending `/readyz`/`_evaluate_trading_health_payload` with a `database` dependency that is derived from existing DB helpers (`check_schema_current`, `check_account_scope_invariants`) and preserves existing `/trading/health` behavior shape.

## Implementation

1. In `services/torghut/app/main.py`:
   - add shared helper `_evaluate_database_contract(session)`.
   - include a new `dependencies["database"]` entry in `_evaluate_trading_health_payload` (used by `/readyz`).
   - reuse the same helper inside `/db-check` to keep contract logic DRY.
2. In `services/torghut/tests/test_trading_api.py`:
   - patch existing readiness tests so schema/account-scope contract defaults are explicit.
   - add regression coverage:
     - mismatch schema heads yields `503` on `/readyz` with `dependencies.database.schema_current == False`.
     - account-scope mismatch (multi-account enabled) yields `503` with `dependencies.database.account_scope_ready == False`.
3. Keep `/trading/health` payload contract unchanged while making `/readyz` the rollout contract anchor.

## Alternatives Considered

- **Option A (Selected): Add database contract dependency into `/readyz`**
  - Pros: one rollout gate, immediate protection against stale migrations and account-scope regressions during probe-based rollout.
  - Cons: additional probe dependency means transient DB metadata races can transiently fail readiness during startup/rolling upgrades.

- **Option B: Keep `/readyz` as-is and make Argo/Knative probe call `/db-check` directly**
  - Pros: no changes to shared readiness payload contract.
  - Cons: larger platform coupling to probing path details and duplicated checks in probes/runtime diagnostics.

- **Option C: Retain only startup-time schema checks (in `lifespan`)**
  - Pros: avoids continuous runtime DB metadata probing.
  - Cons: does not prevent rollout of a pod that already degraded to stale/inconsistent contract after startup.

## Tradeoffs

- This increases coupling between schema health and rollout readiness, which is intentional for reliability but can cause extra readiness flap risk if migrations lag behind deployments.
- Contract checks are intentionally aligned with current `/db-check` semantics and avoid changing existing `trading_health` payload fields.

## Acceptance Criteria

- `/readyz` includes `dependencies.database` and returns `503` when:
  - Alembic migration heads are not current.
  - account-scope invariants fail while multi-account mode is enabled.
- `/db-check` continues to expose `schema_current`, `current_heads`, and `expected_heads` and to enforce the same contract failure modes.
- Regression tests capture both schema-head and account-scope failure modes for readiness.

## Risk and rollback

- Rollback plan:
  - remove `database` dependency from `_evaluate_trading_health_payload`.
  - retain `/db-check` helper logic or remove it and revert to direct checks.
  - this is limited to `services/torghut/app/main.py` and `services/torghut/tests/test_trading_api.py`.
