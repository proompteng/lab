# Chart Controllers HorizontalPodAutoscaler

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
