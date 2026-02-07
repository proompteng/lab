# Chart Canary with Argo Rollouts (Optional Integration)

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
Today the Agents chart uses Kubernetes Deployments. For safer production changes (especially to controllers), operators may want progressive delivery. This doc proposes a chart-compatible integration path with Argo Rollouts without making it a hard dependency.

## Goals
- Provide a supported canary rollout pattern for `agents` and `agents-controllers`.
- Keep default behavior as plain Deployments.

## Non-Goals
- Replacing Argo CD as the GitOps orchestrator.
- Adding bespoke rollout tooling.

## Current State
- Chart renders `kind: Deployment` only:
  - `charts/agents/templates/deployment.yaml`
  - `charts/agents/templates/deployment-controllers.yaml`
- GitOps desired state for install lives in:
  - `argocd/applications/agents/application.yaml`
  - `argocd/applications/agents/kustomization.yaml`

## Design
### Proposed values
Add:
- `progressiveDelivery.enabled` (default `false`)
- `progressiveDelivery.provider: argo-rollouts`
- `progressiveDelivery.canarySteps` (list)

When enabled:
- Render `kind: Rollout` (Argo Rollouts CRD) instead of `Deployment`.
- Keep Services/selectors stable.

### Safety defaults
- Default to 1-step canary with manual pause.
- Keep max surge/unavailable conservative.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `progressiveDelivery.enabled=false` | `Deployment` | Current behavior. |
| `progressiveDelivery.enabled=true` | `Rollout` | Progressive delivery driven by Argo Rollouts controller. |

## Rollout Plan
1. Add chart support behind `progressiveDelivery.enabled=false`.
2. Install Argo Rollouts in a non-prod cluster; enable for controllers only.
3. After stable, enable for control plane if desired.

Rollback:
- Disable `progressiveDelivery.enabled` to fall back to Deployments (requires careful migration; document as “one-time switch”).

## Validation
```bash
helm template agents charts/agents --set progressiveDelivery.enabled=true | rg -n \"kind: Rollout\"
kubectl get crd | rg \"rollouts\\.argoproj\\.io\"
kubectl -n agents get rollout
```

## Failure Modes and Mitigations
- Rollouts CRD not installed: mitigate by render-time validation when feature enabled.
- Switching kinds breaks `kubectl rollout` workflows: mitigate by documenting operational differences and migration steps.

## Acceptance Criteria
- Enabling the flag renders valid manifests and does not break the default install path.
- Controllers can be canaried progressively without changing Services.

## References
- Argo Rollouts documentation: https://argo-rollouts.readthedocs.io/

