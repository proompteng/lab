# 23. Readiness Schema Drift Diagnostics for Deployment Stability (2026-03-04)

## Summary

`torghut` currently reports readiness health as boolean pass/fail for schema readiness in `/readyz` and `/db-check`, but operators cannot quickly distinguish migration drift types when failures occur. When rollout probes flap, teams lose time reconstructing whether a failure is due to missing expected Alembic heads, unexpected extra heads, or a configuration bypass in single-account mode. This proposal adds deterministic schema-drift diagnostics to both readiness and db-check responses.

## Problem

From current cluster observations, `torghut` shows repeated probe failures during revisions (`Readiness probe failed`, `Liveness probe failed`, `503`, and private service endpoint churn) while the rollout path still needs to preserve quick root-cause signals. In production debugging, a single boolean `schema_current` can hide the actual contract mismatch shape, making it harder to know whether failures are transient, pending migration, or drift.

## Decision

Emit and propagate structured migration-contract diagnostics from `check_schema_current` and `_evaluate_database_contract` into:

- `services/torghut/app/db.py`
  - Extend schema-check return with deterministic drift fields:
    - `schema_missing_heads`
    - `schema_unexpected_heads`
    - `schema_head_count_expected`
    - `schema_head_count_current`
    - `schema_head_delta_count`
- `services/torghut/app/main.py`
  - Include the above fields in `/readyz` dependency payload under `dependencies.database`.
  - Include the same fields in `/db-check` diagnostic detail payload.
  - Add `account_scope_warnings` when account-scope checks are intentionally bypassed because `trading_multi_account_enabled=false`.

## Alternatives Considered

- Option A: Keep current boolean-only schema contract outputs.
  - Pros: minimal surface area.
  - Cons: continues to force human investigation during rollout by requiring log correlation for every failure.
- Option B: Add external log enrichment and rely on migration/job logs only.
  - Pros: no API shape changes.
  - Cons: not available in every readiness consumer path and still delayed by log aggregation.
- Option C (selected): Add schema-drift fields directly in contract payloads.
  - Pros: fastest operator path to root-cause, zero extra dependency, additive contract change.
  - Cons: increases payload size and requires endpoint contract test updates.

## Tradeoffs and Risks

- Increased contract payload size is small and additive; clients should ignore unknown fields.
- Diff fields are computed from Alembic head sets, not migration history semantics; they indicate drift shape, not operational severity.
- In single-account mode, bypassed account-scope checks remain possible by design and now emit explicit warnings to prevent silent assumptions.

## Validation

- Added/updated tests in `services/torghut/tests/test_db.py`:
  - schema drift signal assertions for `check_schema_current`.
- Added/updated tests in `services/torghut/tests/test_trading_api.py`:
  - `/db-check` now asserts `schema_missing_heads`, `schema_unexpected_heads`, and head-count diagnostics.
  - `/readyz` failure path asserts schema drift fields in `dependencies.database`.
  - Single-account mode verifies explicit account-scope bypass warnings are visible.

## Rollback

- Remove the new diagnostic fields from `_readiness_dependency_checks`, `_evaluate_database_contract`, and `/db-check` payload assembly while retaining existing schema boolean checks.
- Keep compatibility with schema contract helpers and existing DB checks if diagnostic fields are no longer needed.
