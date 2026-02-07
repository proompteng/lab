# Chart Controllers Service (Optional)

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

