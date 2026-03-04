# Jangar Migration Registry Parity and Governance

Status: Draft (2026-03-04)

Docs index: [README](../README.md)

## Summary

Jangar currently discovers migrations through a manually maintained `MigrationMap` in `services/jangar/src/server/kysely-migrations.ts`. When migration files are added without updating this map, they never execute in startup auto-migration mode, creating silent schema drift risk across environments.

This design enforces registry parity at runtime in test by comparing migration file names against the registered list.

## Current State

- Control plane migration source of truth is `services/jangar/src/server/migrations/*.ts`.
- Runtime registration currently depends on explicit imports and static keys in `services/jangar/src/server/kysely-migrations.ts`.
- There is no automated check that each migration file is represented in `migrations`.
- Existing cluster health evidence already includes restart churn on `jangar` and `jangar-worker` pods, so migration and rollout behavior should be safer by default.

## Problem

Unregistered migration files can be committed and deployed without applying, resulting in application/runtime mismatch:

- missing columns/table definitions referenced by runtime code,
- failed startup during first-time startup with existing data, or
- delayed incident response as drift is only detected post-incident.

## Design Goals

- Eliminate migration registration drift at the repository level.
- Keep operational behavior unchanged for existing environments.
- Make failure obvious before deployment via CI.

## Alternatives Considered

- Option 1: Keep manual registry and add manual review checklist.
  - Pros: minimal code churn.
  - Cons: still relies on human process and is easy to miss in fast iterations.
- Option 2: Auto-discover migration files at startup and sort by filename.
  - Pros: removes manual registration burden entirely.
  - Cons: requires refactor of migration loading behavior and could alter file-name-based loading assumptions (including `index`/helper files or hidden artifacts).
- Option 3: Keep manual registry and add a CI test that asserts registry/file parity.
  - Pros: fast to implement, low risk, explicit intent and governance boundary stays where migrations are imported.
  - Cons: still requires developers to import migration module in code, but now with guaranteed detection if omitted.

## Decision

Adopt Option 3 now for reliability and maintainability with minimum behavioral risk.

- Add a test that reads `services/jangar/src/server/migrations` and asserts a sorted name match with `__test__.getRegisteredMigrations()`.
- Keep explicit import-based registration, which preserves migration execution order and avoids unexpected runtime behavior changes.

## Proposed Changes

1. Add a unit test at `services/jangar/src/server/__tests__/kysely-migrations.test.ts`.
2. Keep existing `kysely-migrations.ts` registry approach but expose a narrow `__test__` accessor for test assertions.
3. Update the file as part of source change once drift is detected (e.g., recent commit added `20251229_codex_judge_run_metadata` and `20260303_jangar_github_write_actions_audit_context`).

## Validation

- Run formatter and type-aware lint on changed files.
- Run the targeted `kysely-migrations` test and the service lint path.
- Confirm no runtime migration registration changes beyond intended additions.

## Handoff Appendix (Source + Operational context)

### Source of truth

- Migration registration: `services/jangar/src/server/kysely-migrations.ts`
- Migration files: `services/jangar/src/server/migrations/`
- Migration tests: `services/jangar/src/server/__tests__/kysely-migrations.test.ts`

### Deployment & validation notes

- This change is scoped to source and CI; no charts/infrastructure changes are required.
- Post-merge, deployment behavior remains dependent on `JANGAR_MIGRATIONS` and existing chart defaults.
