# Chart Deployment Strategy: RollingUpdate Tuning

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
The chart currently relies on Kubernetes default `RollingUpdate` behavior for Deployments. For production, we should explicitly control surge/unavailable and optionally support safer strategies (e.g. `Recreate` for DB-migration-sensitive components).

## Goals
- Provide explicit, chart-configurable Deployment strategies for:
  - `deploy/agents`
  - `deploy/agents-controllers`
- Enable safe canary/rollback patterns with predictable availability.

## Non-Goals
- Replacing GitOps rollout control (Argo CD) with Helm hooks.

## Current State
- Templates:
  - Control plane Deployment: `charts/agents/templates/deployment.yaml` has no `spec.strategy`.
  - Controllers Deployment: `charts/agents/templates/deployment-controllers.yaml` has no `spec.strategy`.
- Values: no strategy knobs exist in `charts/agents/values.yaml`.

## Design
### Proposed values
Add:
- `controlPlane.deploymentStrategy`
- `controllers.deploymentStrategy`
- `deploymentStrategy` (global default)

Each can accept:
```yaml
type: RollingUpdate
rollingUpdate:
  maxSurge: 25%
  maxUnavailable: 0
```

### Defaults
- Control plane:
  - `maxUnavailable: 0` (prefer availability)
- Controllers:
  - `maxUnavailable: 1` (prefer continuity but allow roll)

## Config Mapping
| Helm value | Rendered field | Intended behavior |
|---|---|---|
| `deploymentStrategy` | `Deployment.spec.strategy` | Global default used if component overrides are absent. |
| `controlPlane.deploymentStrategy` | `deploy/agents.spec.strategy` | Component-specific override. |
| `controllers.deploymentStrategy` | `deploy/agents-controllers.spec.strategy` | Component-specific override. |

## Rollout Plan
1. Add new values with conservative defaults matching Kubernetes defaults (no behavior change).
2. In production, set explicit `maxUnavailable`/`maxSurge` values.
3. Validate rollout behavior during a canary image bump.

Rollback:
- Remove values; cluster falls back to defaults.

## Validation
```bash
helm template agents charts/agents | rg -n \"strategy:\"
kubectl -n agents get deploy agents -o yaml | rg -n \"strategy:\"
kubectl -n agents rollout status deploy/agents
```

## Failure Modes and Mitigations
- Too aggressive `maxUnavailable` causes downtime: mitigate by defaulting to `0` for control plane.
- Surge causes resource pressure: mitigate by setting explicit `maxSurge` and sizing cluster capacity.

## Acceptance Criteria
- Operators can tune rollout availability without editing templates.
- Both Deployments render with explicit strategy when configured.

## References
- Kubernetes Deployment strategy: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

