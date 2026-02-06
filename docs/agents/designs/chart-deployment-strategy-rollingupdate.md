# Chart Deployment Strategy: RollingUpdate Tuning

Status: Draft (2026-02-06)

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

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart behavior: `charts/agents/values.yaml`, `charts/agents/values.schema.json`, `charts/agents/templates/`
- Chart render-time validation: `charts/agents/templates/validation.yaml`
- GitOps desired state:
  - `agents` app (CRDs + controllers + service): `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
  - `jangar` app (product deployment + primitives): `argocd/applications/jangar/kustomization.yaml`
  - Product enablement: `argocd/applicationsets/product.yaml`

### Values → env var mapping (chart)
- Control plane env var merge + rendering: `charts/agents/templates/deployment.yaml`
- Controllers env var merge + rendering: `charts/agents/templates/deployment-controllers.yaml`
- Common pattern: `.Values.env.vars` are merged with component-specific vars (control plane: `.Values.controlPlane.env.vars`, controllers: `.Values.controllers.env.vars`). Component-specific keys win.

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

### Rollout plan (GitOps)
1. Change chart templates/values/schema in `charts/agents/**`.
2. If the chart `version:` changes, keep `charts/agents/Chart.yaml` and `argocd/applications/agents/kustomization.yaml` in sync.
3. Validate rendering locally (no cluster access required):

```bash
mise exec helm@3.15.4 -- helm lint charts/agents
mise exec helm@3.15.4 -- helm template agents charts/agents -n agents -f argocd/applications/agents/values.yaml --include-crds > /tmp/agents.helm.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
scripts/agents/validate-agents.sh
```

4. Merge to `main`; Argo CD reconciles.

### Validation (post-merge)
- Confirm Argo sync + workloads healthy:

```bash
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl logs -n agents deploy/agents-controllers --tail=200
```
