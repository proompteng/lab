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
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml`, `argocd/applications/argo-workflows/*.yaml`

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`charts/agents/templates/deployment.yaml` via `.Values.controlPlane.image.*`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`charts/agents/templates/deployment-controllers.yaml` via `.Values.image.*` unless `.Values.controllers.image.*` is set): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Controllers enabled: `controllers.enabled: true` (separate `agents-controllers` deployment). See `argocd/applications/agents/values.yaml`.
- gRPC enabled: chart `grpc.enabled: true` and runtime `JANGAR_GRPC_ENABLED: "true"` in `.Values.env.vars`. See `argocd/applications/agents/values.yaml`.
- Database configured via SecretRef: `database.secretRef.name: jangar-db-app` and `database.secretRef.key: uri` (rendered as `DATABASE_URL`). See `argocd/applications/agents/values.yaml` and `charts/agents/templates/deployment.yaml`.

Note: Treat `charts/agents/**` and `argocd/applications/**` as the desired state. To verify live cluster state, run:

```bash
kubectl get application -n argocd agents
kubectl get application -n argocd froussard
kubectl get ns | rg '^(agents|agents-ci|jangar|froussard)\b'
kubectl get deploy -n agents
kubectl get crd | rg 'proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access):
  - `kubectl get pods -n agents`
  - `kubectl logs -n agents deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
