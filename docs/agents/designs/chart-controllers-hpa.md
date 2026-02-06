# Chart Controllers HorizontalPodAutoscaler

Status: Draft (2026-02-06)

## Overview
The chart’s HPA template targets only the control plane Deployment (`agents`). Controllers are deployed as a separate Deployment (`agents-controllers`) but do not have autoscaling support. Controllers workload is often bursty (reconcile storms, webhook bursts), and lack of scaling can cause backlog and delayed reconciliation.

## Goals
- Add optional HPA support for `agents-controllers`.
- Keep existing `autoscaling.*` behavior unchanged for the control plane.

## Non-Goals
- Implementing custom metrics autoscaling in this phase.

## Current State
- Existing HPA template: `charts/agents/templates/hpa.yaml`
  - Targets `Deployment/{{ include "agents.fullname" . }}` only.
- Values: `charts/agents/values.yaml` exposes a single `autoscaling.*`.
- Controllers deployment: `charts/agents/templates/deployment-controllers.yaml`.

## Design
### Proposed values
Add:
- `controllers.autoscaling` (new)

### Defaults
- `controllers.autoscaling.enabled=false`
- Recommend `minReplicas: 1`, `maxReplicas: 3` initially, CPU-based scaling only.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `autoscaling.*` | `HPA/agents` | Control plane HPA (existing). |
| `controllers.autoscaling.enabled=true` | `HPA/agents-controllers` | Scales controllers Deployment based on CPU/memory. |

## Rollout Plan
1. Add new `controllers.autoscaling` keys with defaults disabled.
2. Enable in non-prod and validate scale-up/down behavior.
3. Enable in prod after ensuring PDB/strategy supports scaling safely.

Rollback:
- Disable `controllers.autoscaling.enabled`.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true --set controllers.autoscaling.enabled=true | rg -n \"kind: HorizontalPodAutoscaler\"
kubectl -n agents get hpa
```

## Failure Modes and Mitigations
- HPA scales down too aggressively and loses in-flight work: mitigate with conservative scale-down policies and controller graceful shutdown.
- HPA not created due to missing metrics server: mitigate by documenting prerequisites and keeping disabled by default.

## Acceptance Criteria
- When enabled, `agents-controllers` has an HPA targeting the correct Deployment.
- Operators can scale controllers independently of the control plane.

## References
- Kubernetes HPA v2: https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/

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
