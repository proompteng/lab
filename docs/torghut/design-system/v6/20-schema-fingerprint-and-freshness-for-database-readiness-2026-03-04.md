# 20. Schema Fingerprint Freshness in Readiness and Database Contract Endpoints (2026-03-04)

## Summary

- `torghut` reliability should include schema freshness metadata in rollout-facing and operator-facing checks, not just boolean contract pass/fail.
- This change adds a deterministic Alembic head fingerprint and a monotonic check timestamp to both `/readyz` and `/db-check` outputs so rollout engines and on-call operators can distinguish a stale contract from temporary probe latency.

## Problem

- Rollout readiness currently treats schema contract checks as pass/fail but does not expose contract freshness evidence.
- Cluster events already show readiness/liveness drift, and debugging currently requires ad-hoc inspection of DB migration state and logs.
- Maintenance burden increases when multiple migration heads are introduced because contract outputs do not provide a compact diff-safe identifier for schema shape drift.

## Decision

Promote deterministic schema contract metadata into all database-dependent contract checks:

- `services/torghut/app/db.py`
  - cache sorted Alembic heads in `_get_expected_schema_heads()` for consistency and repeated-call stability.
  - derive `expected_heads_signature` in `_schema_heads_signature()`.
  - keep existing `check_schema_current()` return semantics while adding the signature field.
- `services/torghut/app/main.py`
  - expose `schema_head_signature` and `checked_at` in `/readyz` and `/db-check` payloads.
  - preserve existing `ok`, `schema_current`, `current_heads`, and `expected_heads` fields for compatibility.

## Alternatives Considered

- Option A: add metadata fields only to `/db-check`.
  - Pros: minimal surface for external readiness consumers.
  - Cons: rollout still lacks freshness evidence, so operators still need extra DB checks.
- Option B: persist a separate schema-metadata table and read it inside `/readyz`.
  - Pros: allows richer history and retention.
  - Cons: adds DB writes and migration dependency for every startup path; unnecessary risk for this objective.
- Option C (selected): include `schema_head_signature` and `checked_at` directly in existing contract payloads.
  - Pros: zero schema changes, low blast radius, immediate rollout and operations value.
  - Cons: timestamp formatting is local to service and must remain stable.

## Tradeoffs

- This coupling increases operational observability with minimal API changes, but external systems may need to ignore new fields if strict schema validation is in place.
- Signature freshness is a single digest of head names, not a data-quality validator; migration contents still must be validated by existing migration checks/tests.
- Caching head metadata improves determinism and avoids repeated filesystem parsing, while still recomputing only when process restarts.

## Implementation Notes

- `schema_head_signature` is computed as `sha256(','.join(sorted(expected_heads))).hexdigest()`.
- `checked_at` uses UTC ISO timestamps generated during contract evaluation.
- `/readyz` continues to reflect readiness status and status codes; database contract metadata is surfaced under `dependencies.database`.

## Validation Added

- `services/torghut/tests/test_db.py`
  - deterministic sorting/signature behavior for `check_schema_current`.
  - cache behavior for `_get_expected_schema_heads`.
- `services/torghut/tests/test_trading_api.py`
  - `/db-check` and `/readyz` assertions include `schema_head_signature` and `checked_at`.
  - regression coverage for schema mismatch and account-scope mismatch still returning 503 when included in readiness path.

## Rollback

- Remove the added keys from `dependencies.database` and `/db-check` response construction and keep boolean contract checks intact.
- Keep `check_schema_current()` caching/signature helper in `db.py` if needed for later telemetry-only use.
