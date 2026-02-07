# Controllers Deployment: Migrations Skipped by Default

Status: Draft (2026-02-07)

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

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen: `services/jangar/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Controllers:
  - Agents/AgentRuns: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable):
  - `argocd/applications/froussard/codex-autonomous-workflow-template.yaml`
  - `argocd/applications/froussard/codex-run-workflow-template-jangar.yaml`
  - `argocd/applications/froussard/github-codex-implementation-workflow-template.yaml`
  - `argocd/applications/froussard/github-codex-post-deploy-workflow-template.yaml`

### Current cluster state
As of 2026-02-07 (repo `main` desired state + best-effort live version):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps: control plane `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` and controllers `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`. See `argocd/applications/agents/values.yaml`.
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Live cluster Kubernetes version (from this environment): `v1.35.0+k3s1` (`kubectl version`).

Note: The safest “source of truth” for rollout planning is the desired state (`argocd/applications/**` + `charts/agents/**`). Live inspection may require elevated RBAC.

To verify live cluster state (requires permissions):

```bash
kubectl version --output=yaml | rg -n "serverVersion|gitVersion|platform"
kubectl get application -n argocd agents
kubectl -n agents get deploy
kubectl -n agents get pods
kubectl get crd | rg 'agents\.proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

High-signal mappings to remember:
- `env.vars.*` / `controlPlane.env.vars.*` / `controllers.env.vars.*` → container `env:` (merge precedence is defined in `docs/agents/designs/chart-env-vars-merge-precedence.md`)
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` and `JANGAR_PRIMITIVES_NAMESPACES`
- `grpc.*` and/or `env.vars.JANGAR_GRPC_*` → `JANGAR_GRPC_{ENABLED,HOST,PORT}`
- `database.*` → `DATABASE_URL` + optional `PGSSLROOTCERT`

### Rollout plan (GitOps)
1. Update code + chart + CRDs together when APIs change:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `bun run lint:argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access): apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
