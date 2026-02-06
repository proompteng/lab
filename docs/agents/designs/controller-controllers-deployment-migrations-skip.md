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

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Controller implementation: `services/jangar/src/server/agents-controller.ts`
- Supporting controllers:
  - Orchestration: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks: `services/jangar/src/server/primitives-policy.ts`
- Chart env var wiring (controllers deployment): `charts/agents/templates/deployment-controllers.yaml`
- GitOps desired state: `argocd/applications/agents/values.yaml` (inputs to chart)

### Values → env var mapping (controllers)
- `controller.*` values in `charts/agents/values.yaml` map to `JANGAR_AGENTS_CONTROLLER_*` env vars in `charts/agents/templates/deployment-controllers.yaml`.
- The controller reads env via helpers like `parseEnvStringList`, `parseEnvRecord`, `parseJsonEnv` in `services/jangar/src/server/agents-controller.ts`.

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`, desired state in Git):
- `agents` Argo CD app (namespace `agents`) installs `charts/agents` via kustomize-helm (release `agents`, chart `version: 0.9.1`, `includeCRDs: true`). See `argocd/applications/agents/kustomization.yaml`.
- Images pinned for `agents`:
  - Control plane (`deploy/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` (from `controlPlane.image.*`).
  - Controllers (`deploy/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809` (from `image.*`).
- Namespaced reconciliation: `controller.namespaces: [agents]`, `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- `jangar` Argo CD app (namespace `jangar`) deploys the product UI/control plane plus default “primitive” CRs (AgentProvider/Agent/Memory/etc). See `argocd/applications/jangar/kustomization.yaml`.
- Jangar image pinned for `jangar` (`deploy/jangar`): `registry.ide-newton.ts.net/lab/jangar:19448656@sha256:15380bb91e2a1bb4e7c59dce041859c117ceb52a873d18c9120727c8e921f25c` (from `argocd/applications/jangar/kustomization.yaml`).

Render the exact YAML Argo CD applies:

```bash
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/jangar > /tmp/jangar.rendered.yaml
```

Verify live cluster state (requires kubeconfig):

```bash
mise exec kubectl@1.30.6 -- kubectl get application -n argocd agents
mise exec kubectl@1.30.6 -- kubectl get application -n argocd jangar
mise exec kubectl@1.30.6 -- kubectl get ns | rg '^(agents|agents-ci|jangar)\b'
mise exec kubectl@1.30.6 -- kubectl get deploy -n agents
mise exec kubectl@1.30.6 -- kubectl get deploy -n jangar
mise exec kubectl@1.30.6 -- kubectl get crd | rg 'proompteng\.ai'
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl rollout status -n jangar deploy/jangar
```

### Rollout plan
1. Update controller code under `services/jangar/src/server/`.
2. Build/push image(s) (out of scope in this doc set); then update GitOps pins:
   - `argocd/applications/agents/values.yaml` (controllers/control plane images)
   - `argocd/applications/jangar/kustomization.yaml` (product `jangar` image)
3. Merge to `main`; Argo CD reconciles.

### Validation
- Unit tests (fast): `bun run --filter jangar test`
- Render desired manifests (no cluster needed):

```bash
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
```

- Live cluster (requires kubeconfig): see commands in “Current cluster state” above.
