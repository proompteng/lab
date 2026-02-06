# Chart Resources: Component Overrides

Status: Draft (2026-02-06)

## Overview
The Agents chart exposes `resources` as a global default and also supports component-specific overrides (`controlPlane.resources`, `controllers.resources`). These overrides are implemented in templates but not explicitly documented, which increases the chance of accidentally starving controllers or the control plane in production.

## Goals
- Document the current override behavior and make it explicit.
- Recommend production defaults for control plane vs controllers.
- Ensure resource settings are observable via Helm render and `kubectl`.

## Non-Goals
- Autosizing resources automatically.
- Changing scheduling/affinity policies (handled separately).

## Current State
- Values:
  - Global: `charts/agents/values.yaml` → `resources`
  - Control plane override: `charts/agents/values.yaml` → `controlPlane.resources`
  - Controllers override: `charts/agents/values.yaml` → `controllers.resources`
- Template wiring:
  - Control plane uses `$resources := .Values.controlPlane.resources | default .Values.resources` in `charts/agents/templates/deployment.yaml`.
  - Controllers uses `$resources := .Values.controllers.resources | default .Values.resources` in `charts/agents/templates/deployment-controllers.yaml`.
- Cluster desired state sets `resources.requests` globally in `argocd/applications/agents/values.yaml` but does not set per-component overrides.

## Design
### Contract
- If a component override is an empty object (`{}`), it is treated as “unset” and the component inherits from global `resources`.
- Production guidance:
  - Controllers should have explicit requests/limits tuned for reconcile throughput.
  - Control plane should have explicit requests/limits tuned for serving traffic and background tasks.

### Recommended chart documentation
Add a chart README section:
- “Resource precedence” with examples showing:
  - Global only
  - Controllers-only override
  - Control-plane-only override

## Config Mapping
| Helm value | Pod resources target | Behavior |
|---|---|---|
| `resources` | `deploy/agents` and `deploy/agents-controllers` | Baseline default for all components. |
| `controlPlane.resources` | `deploy/agents` | Overrides global for control plane only. |
| `controllers.resources` | `deploy/agents-controllers` | Overrides global for controllers only. |

## Rollout Plan
1. Document precedence (no behavior change).
2. In GitOps, set explicit per-component requests for production.
3. Add alerting to catch CPU throttling / OOMKilled during canary (operational follow-up).

Rollback:
- Revert values changes; chart behavior remains backward compatible.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"resources:|requests:|limits:\"
kubectl -n agents get deploy agents -o yaml | rg -n \"resources:\"
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"resources:\"
```

## Failure Modes and Mitigations
- Controllers starve and fall behind: mitigate by explicit controller requests and by monitoring reconcile lag.
- Control plane throttles under API load: mitigate by explicit control plane requests and HPA (if enabled).
- Values changes accidentally apply to both components: mitigate by using component overrides and validating rendered manifests.

## Acceptance Criteria
- Documentation clearly explains precedence and examples.
- Production GitOps values can size controllers separately from the control plane.

## References
- Kubernetes resource requests/limits: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/

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
