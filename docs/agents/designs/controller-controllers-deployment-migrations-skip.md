# Controllers Deployment: Migrations Skipped by Default

Status: Draft (2026-02-06)

## Overview
Database migrations are potentially disruptive and should not be run by the controllers deployment. The chart enforces this by defaulting `JANGAR_MIGRATIONS=skip` in the controllers Deployment unless explicitly overridden. This behavior should be documented and protected by validation.

## Goals
- Keep migrations in the control plane only (or in a dedicated migration job).
- Ensure controllers never run migrations accidentally.

## Non-Goals
- Redesigning the migration system (Kysely/SQL).

## Current State
- Chart sets default in `charts/agents/templates/deployment-controllers.yaml`:
  - If `JANGAR_MIGRATIONS` is not present in `controllers.env.vars`, set it to `"skip"`.
- Migration behavior is implemented in `services/jangar/src/server/kysely-migrations.ts`:
  - `resolveMigrationsMode()` treats missing/unknown as `auto`, explicit “skip/disabled/false/0/off” as `skip`.
- Control plane default in `charts/agents/values.yaml` is `env.vars.JANGAR_MIGRATIONS: auto`.

## Design
### Contract
- Controllers MUST always run with migrations disabled (skip).
- Control plane may run migrations (`auto`) OR migrations may be moved to an init Job (future).

### Validation
- Chart validation:
  - Fail render if `controllers.env.vars.JANGAR_MIGRATIONS` is set to any non-skip value.
- Controller startup validation:
  - If `JANGAR_MIGRATIONS` resolves to `auto`, exit non-zero with an actionable error.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `env.vars.JANGAR_MIGRATIONS=auto` | `JANGAR_MIGRATIONS` | Control plane may apply migrations. |
| `controllers.env.vars.JANGAR_MIGRATIONS=skip` | `JANGAR_MIGRATIONS` | Controllers never run migrations. |

## Rollout Plan
1. Add documentation and chart validation (initially warning-only if needed).
2. Add controller startup fail-fast validation.
3. Optionally move migrations to a dedicated Job later.

Rollback:
- Revert controller startup validation (code rollback) if it blocks an unexpected environment.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true | rg -n \"JANGAR_MIGRATIONS\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"migration|migrations\"
```

## Failure Modes and Mitigations
- Controllers run migrations during rollout: mitigate by chart defaults + strict validation.
- Control plane migration failures block startup: mitigate by allowing operators to set `JANGAR_MIGRATIONS=skip` on control plane as an emergency fallback.

## Acceptance Criteria
- Controllers cannot be configured (via Helm) to run migrations.
- The effective mode is visible in rendered manifests and logs.

## References
- Kubernetes init containers and migration patterns: https://kubernetes.io/docs/concepts/workloads/pods/init-containers/

