# Jangar Control Plane Migration Consistency Status

Status: Draft (2026-03-04)

Docs index: [README](../README.md)

## Summary

This design defines a control-plane status signal for DB migration consistency so operators can detect schema drift before it impacts runtime behavior. It complements the existing workflow reliability status surface by adding a `migration_consistency` block under `database` in `/api/agents/control-plane/status`.

The design is low-risk because it does not block startup, does not write to the database, and reuses the existing migration registry source and typed DB access layer.

## Problem

Current status checks confirm DB connectivity but do not validate the health of migration state. A deployment can:

- report DB as healthy while migrations are missing in production,
- report DB as healthy while older migration files are no longer applied,
- or diverge from declared migration files due to accidental file omissions.

This blind spot delays detection of schema incompatibilities and makes rollout incidents less debuggable.

## Context and current behavior

- `services/jangar/src/server/kysely-migrations.ts` maintains explicit migration registration.
- `services/jangar/src/server/control-plane-status.ts` validates DB connectivity and latency but does not compare schema history against registration.
- UI surfaces and API consumers use `DatabaseStatus` from `services/jangar/src/data/agents-control-plane.ts`.
- There is existing migration-coverage work in progress around status reporting and workflow reliability.

## Alternatives and tradeoffs

1. Startup-only migration enforcement
   - Fail startup when `registered !== applied`.
   - Pros: strongest immediate safety; prevents operations under mismatched schema.
   - Cons: higher blast radius and lower resilience during partial upgrades or one-off reconciliation windows.

2. CI-only registry parity checks only
   - Add/extend test coverage in CI to assert migration files and registry entries match.
   - Pros: cheap and deterministic; catches some classes of drift in merge checks.
   - Cons: blind to runtime-environment drift and does not provide operator-facing signal.

3. Runtime status-consistency signal (selected)
   - Add bounded, non-blocking status read path with `database.migration_consistency`.
   - Pros: immediate operational visibility from existing control-plane tooling; supports de-noised response playbooks and rollback gating.
   - Cons: requires extra DB read in status endpoint and can surface false-positive noise if migration tracking tables are intentionally transient during custom maintenance tasks.

## Design decision

Choose option 3 (runtime status-consistency signal).

- Keep migration check behavior non-blocking and additive:
  - when table is missing, return degraded `migration_consistency` with explicit message,
  - when drift is detected, mark database status degraded and expose `unapplied_count`, `unexpected_count`, and migration lists.
- Preserve current status contract by preserving existing fields and adding nested `database.migration_consistency`.
- Keep rollout compatibility: unknown connection state remains unchanged and still reported as DB degraded.

## Proposed implementation

- Add deterministic migration table discovery in `services/jangar/src/server/control-plane-status.ts`:
  - `kysely_migration` primary candidate, with fallback to `kysely_migrations`.
- Compare registered migration list (`getRegisteredMigrationNames`) with applied names read from the resolved table.
- Surface:
  - `registered_count`
  - `applied_count`
  - `unapplied_count`
  - `unexpected_count`
  - `latest_registered`
  - `latest_applied`
  - `missing_migrations`
  - `unexpected_migrations`
  - `message`
  - `status` (`healthy`/`degraded`/`unknown`)
- Extend `DatabaseStatus` in `services/jangar/src/data/agents-control-plane.ts` and update control-plane status tests.
- Keep `control-plane-status` response deterministic with bounded payload and no throw-through.

## Validation

- Unit test in `services/jangar/src/server/__tests__/control-plane-status.test.ts`:
  - healthy baseline with full consistency,
  - degraded when migration drift exists (`unapplied_count > 0`),
  - degraded when query failures occur.
- Keep formatting/lint checks for touched TypeScript paths.

## Risk controls

- If migration tracking table names change again, detection will report as degraded unknown to avoid false healthy signals.
- If this causes noisy status churn during controlled maintenance, reduce query window by gating with dedicated env flags before adding any blocking behavior in a follow-up change.

## Rollout plan

1. Merge as plan-stage design + implementation.
2. Monitor `/api/agents/control-plane/status` migration_consistency fields during next rollout.
3. Escalate to startup gate only if frequent mismatches indicate recurring deployment breakage.

