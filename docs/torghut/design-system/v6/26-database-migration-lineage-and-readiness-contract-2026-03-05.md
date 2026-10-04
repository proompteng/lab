# 26. Migration Lineage Governance and Readiness Contract for `torghut` Database Evolvability (2026-03-05)

## Summary

`torghut` currently validates schema freshness as an Alembic head-set check in `/readyz` and `/db-check`, but source control shows a fragmented migration graph: a split at `0010_execution_provenance_and_governance_trace`, another split at `0015_whitepaper_workflow_tables`, and a branch reset at `0012_lean_multilane_foundation` (`down_revision = n/a`). Combined with frequent migration-dependent startup checks and cluster jobs that already show mixed implementation stability, this is a maintainability and rollout reliability risk.

This design introduces a dedicated migration-lineage governance contract so the service and CI can distinguish **“new migration revision exists”** from **“migration lineage is coherent enough for deterministic rollout”**.

## Design Proposal

### 1) Capture migration graph metadata in `app.db`

Add a deterministic graph summary helper in `services/torghut/app/db.py`:

- Parse `migrations/versions/*.py` for `revision` and `down_revision`.
- Compute:
  - `expected_migration_heads`
  - `expected_migration_roots`
  - `expected_migration_branch_count`
  - `expected_migration_parent_forks` (map of parents with >1 child)
  - `expected_schema_graph_signature` (stable hash of the graph)

### 2) Extend database contract outputs

Enhance `_evaluate_database_contract` and `/db-check` payload to include:

- `schema_graph_signature`
- `schema_graph_roots`
- `schema_graph_branch_count`
- `schema_graph_parent_forks` (empty in healthy state)
- Existing detailed diff fields (`schema_missing_heads`, `schema_unexpected_heads`, counts)

Keep current boolean pass/fail semantics so existing monitoring remains compatible.

### 3) Enforce lineage policy with explicit allowlist in service settings

Introduce config:

- `TRADING_DB_SCHEMA_GRAPH_BRANCH_TOLERANCE` (default: `1`), interpreted as maximum tolerated branch count in expected DAG.
- `TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS` (default: `false`) when explicitly allowing known intentional multi-branch behavior for controlled rollout windows.

During DB contract evaluation:

- If `schema_graph_branch_count > tolerance` and multi-branch tolerance is not enabled, return a dedicated warning/error detail explaining that head drift is not the only issue; lineage is divergent.
- If tolerance exceeded and bypass allowed, emit warnings instead of hard fail, preserving existing operational flexibility while making risk explicit.

### 4) Add validation and regression tests

- Add unit test coverage in `services/torghut/tests/test_db.py` for graph parsing:
  - verifies branch-count inference for current repo graph,
  - verifies root detection and fork detection,
  - verifies stable signature.
- Add endpoint assertion in `services/torghut/tests/test_trading_api.py` for `/db-check` payload now returning lineage fields.

### 5) Add CI guardrails for migration history hygiene

In `services/torghut` CI path, add a small check task to parse the migration graph and fail when:

- Expected graph has more roots than configured tolerance.
- Duplicate revision identifiers or orphaned revision files are introduced.
- Non-linear history is introduced without explicit config override in the same change.

## Problem/Decision Rationale

### Evidence from current assessment

- Static migration parse reveals 19 migration files with clear fan-out:
  - `0010_execution_provenance_and_governance_trace` has two children (`0011_*` and `0011_*` path split).
  - `0015_whitepaper_workflow_tables` has two children (`0016_*` split).
  - `0012_lean_multilane_foundation` starts with `down_revision = n/a`, creating a second root lineage.
- Live cluster evidence shows `torghut` jobs continuing to report readiness churn in parallel with dependency issues, while DB direct validation is blocked by RBAC (`pods/exec` and `ports/forward` denied), so we can only validate readiness from read-only signals and contract checks.
- Source-level readiness currently already reports schema head deltas, so the missing gap is primarily **lineage semantics and intent visibility**.

## Alternatives Considered

1. Keep status quo (head-set checks only)

- Pros: no schema contract surface changes.
- Cons: cannot explain multi-root or forked migration intent; operators see drift but not origin.

2. Enforce single-head migration history only immediately

- Pros: simplest for rollout safety.
- Cons: too disruptive today because branching already exists; high chance of blocking existing valid release train until migration graph is reworked.

3. Introduce lineage contract + explicit tolerance (selected)

- Pros: preserves existing behavior, adds observability and guardrails, supports staged migration strategies where multi-branch is intentional and reviewed.
- Cons: adds extra config surface and requires test updates around migration metadata.

## Tradeoffs and Risks

- Conservative default (tolerance = 1) may surface current branching as warnings until an intentional policy is set and documented.
- Signature and fork metadata depends on migration file parsing in-process; this is deterministic but should be cached.
- Parsing migrations in runtime path must be bounded and cached to avoid startup overhead.

## Rollout Plan

1. Ship design updates in `services/torghut` with no hard block by default (`TRADING_DB_SCHEMA_GRAPH_BRANCH_TOLERANCE=1`, `TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true` for now).
2. Backfill migration hygiene by introducing merge migrations and reducing branching, then tighten policy to strict tolerance.
3. Update operations runbooks: a non-empty `schema_graph_parent_forks` should trigger schema-lineage review.

## Verification

- Unit and API tests for lineage fields in `/db-check` and readiness payloads.
- CI policy check in `services/torghut` that rejects orphaned / multi-root PRs unless explicitly documented with migration override.
