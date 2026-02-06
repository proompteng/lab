# Chart Controllers Service (Optional)

Status: Draft (2026-02-06)

## Overview
The controllers Deployment is currently internal-only and has no Service. That is usually fine, but it complicates:
- NetworkPolicy authoring (targeting stable endpoints)
- Debug access to health endpoints (if provided)
- Future webhook endpoints or internal RPC

This doc proposes an optional Service for controllers with a conservative default (disabled).

## Goals
- Provide an opt-in ClusterIP Service for `agents-controllers`.
- Keep default behavior unchanged.

## Non-Goals
- Exposing controllers publicly.

## Current State
- Controllers Deployment exists when `controllers.enabled=true`: `charts/agents/templates/deployment-controllers.yaml`.
- Services exist only for control plane HTTP and optional gRPC:
  - `charts/agents/templates/service.yaml`
  - `charts/agents/templates/service-grpc.yaml`
- No Service selects `agents.controllersSelectorLabels`.

## Design
### Proposed values
Add:
- `controllers.service.enabled` (default `false`)
- `controllers.service.port` (default `8080` if controllers expose HTTP health)
- `controllers.service.annotations` / `labels`

### Selector + ports
- Selector MUST match `agents.controllersSelectorLabels`.
- Port naming should align with container ports if present.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `controllers.service.enabled=false` | none | Current behavior. |
| `controllers.service.enabled=true` | `Service/agents-controllers` | Stable in-cluster endpoint for debug/health as needed. |

## Rollout Plan
1. Add values and template behind disabled default.
2. Enable in non-prod to confirm selector and endpoints.
3. Use as a dependency for any future controller webhooks or debug tooling.

Rollback:
- Disable `controllers.service.enabled`.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true --set controllers.service.enabled=true | rg -n \"kind: Service|agents-controllers\"
kubectl -n agents get svc
kubectl -n agents get endpoints agents-controllers
```

## Failure Modes and Mitigations
- Service selects wrong pods: mitigate with stable selector helpers and render tests.
- Service unintentionally exposed via mesh or gateway defaults: mitigate by ClusterIP default and explicit docs.

## Acceptance Criteria
- Enabling the value renders a Service selecting only controller pods.
- Default install remains unchanged.

## References
- Kubernetes Service type ClusterIP: https://kubernetes.io/docs/concepts/services-networking/service/

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
