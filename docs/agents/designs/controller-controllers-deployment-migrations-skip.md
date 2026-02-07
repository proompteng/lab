# Controllers Deployment: Migrations Skipped by Default

Status: Draft (2026-02-06)

## Production / GitOps (source of truth)
These design notes are kept consistent with the live *production desired state* (GitOps) and the in-repo `charts/agents` chart.

### Current production deployment (desired state)
- Namespace: `agents`
- Argo CD app: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml` (chart `charts/agents`, chart version `0.9.1`, release `agents`)
- Values overlay: `argocd/applications/agents/values.yaml` (pins images + digests, DB SecretRef, gRPC, and `envFromSecretRefs`)
- Additional in-cluster resources (GitOps-managed): `argocd/applications/agents/*.yaml` (Agent/Provider, SecretBinding, VersionControlProvider, samples)

### Chart + code (implementation)
- Chart entrypoint: `charts/agents/Chart.yaml`
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- Templates: `charts/agents/templates/`
- CRDs installed by the chart: `charts/agents/crds/`
- Example CRs: `charts/agents/examples/`
- Control plane + controllers code: `services/jangar/src/server/`

### Values ↔ env mapping (common)
- `.Values.env.vars` → base Pod `env:` for control plane + controllers (merged; component-local values win).
- `.Values.controlPlane.env.vars` → control plane-only overrides.
- `.Values.controllers.env.vars` → controllers-only overrides.
- `.Values.envFromSecretRefs[]` → Pod `envFrom.secretRef` (Secret keys become env vars at runtime).

### Rollout + validation (production)
- Rollout path: edit `argocd/applications/agents/` (and/or `charts/agents/`), commit, and let Argo CD sync.
- Render exactly like Argo CD (Helm v3 + kustomize):
  ```bash
  helm lint charts/agents
  mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.rendered.yaml
  ```
- Validate in-cluster (requires RBAC allowing reads in `agents`):
  ```bash
  kubectl -n agents get deploy,svc,pdb,cm
  kubectl -n agents describe deploy agents
  kubectl -n agents describe deploy agents-controllers || true
  kubectl -n agents logs deploy/agents --tail=200
  kubectl -n agents logs deploy/agents-controllers --tail=200 || true
  ```

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

