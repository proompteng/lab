# Chart Kubernetes API Host/Port Override

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
The chart exposes `kubernetesApi.host` and `kubernetesApi.port` which map to `KUBERNETES_SERVICE_HOST` and `KUBERNETES_SERVICE_PORT`. This is a sharp tool: it can help run outside-cluster or in unusual networking environments, but can also break in-cluster discovery if misused.

## Goals
- Document when and how to use the override safely.
- Add guardrails to prevent accidental use in normal in-cluster deployments.

## Non-Goals
- Providing full out-of-cluster deployment support.

## Current State
- Values: `charts/agents/values.yaml` includes `kubernetesApi.host` and `kubernetesApi.port`.
- Templates set env vars for both deployments:
  - `charts/agents/templates/deployment.yaml`
  - `charts/agents/templates/deployment-controllers.yaml`
- Default is empty (Kubernetes default service env vars apply).

## Design
### Contract
- In-cluster installs SHOULD leave `kubernetesApi.*` empty.
- If either `kubernetesApi.host` or `kubernetesApi.port` is set, both MUST be set.
- The chart SHOULD validate the above in `values.schema.json`.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `kubernetesApi.host` | `KUBERNETES_SERVICE_HOST` | Overrides API endpoint host. |
| `kubernetesApi.port` | `KUBERNETES_SERVICE_PORT` | Overrides API endpoint port. |

## Rollout Plan
1. Add schema validation requiring both host and port together.
2. Add README guidance and examples (in-cluster vs special cases).

Rollback:
- Clear the override values and re-sync.

## Validation
```bash
helm template agents charts/agents | rg -n \"KUBERNETES_SERVICE_HOST|KUBERNETES_SERVICE_PORT\"
kubectl -n agents get deploy agents -o yaml | rg -n \"KUBERNETES_SERVICE_HOST|KUBERNETES_SERVICE_PORT\"
```

## Failure Modes and Mitigations
- Override breaks in-cluster API access: mitigate by default empty + schema guardrails.
- Only host or port set causes confusing behavior: mitigate by schema enforcement.

## Acceptance Criteria
- It is impossible (via schema) to set only one of host/port.
- Operators can identify overrides in rendered manifests.

## References
- Kubernetes in-cluster configuration: https://kubernetes.io/docs/tasks/run-application/access-api-from-pod/

