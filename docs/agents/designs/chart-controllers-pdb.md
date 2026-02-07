# Chart Controllers PodDisruptionBudget

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
The chart can deploy a separate controllers Deployment (`agents-controllers`), but the chart’s PodDisruptionBudget (PDB) template currently only targets the control plane pods. This creates an availability gap: controllers may all be evicted during node drains or cluster maintenance even when the control plane is protected.

## Goals
- Add optional PDB support for `agents-controllers`.
- Keep backward compatibility for existing installs using `podDisruptionBudget.*`.

## Non-Goals
- Enforcing a single organization-wide disruption policy.

## Current State
- Existing PDB template: `charts/agents/templates/poddisruptionbudget.yaml`
  - Selects `{{ include "agents.selectorLabels" . }}` (control plane).
- Controllers selector labels differ: `charts/agents/templates/_helpers.tpl` (`agents.controllersSelectorLabels`).
- Values: `charts/agents/values.yaml` exposes `podDisruptionBudget.*` (single set).
- Cluster desired state: `argocd/applications/agents/values.yaml` does not enable a PDB.

## Design
### Proposed values
Add component-scoped PDBs:
- `controlPlane.podDisruptionBudget` (defaults to existing `podDisruptionBudget`)
- `controllers.podDisruptionBudget` (new)

### Defaults
- Keep existing `podDisruptionBudget.enabled=false`.
- When controllers are enabled, recommend enabling a PDB with `maxUnavailable: 1` for controllers.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `podDisruptionBudget.*` | `PodDisruptionBudget/agents` | Backward compatible control plane PDB. |
| `controllers.podDisruptionBudget.enabled=true` | `PodDisruptionBudget/agents-controllers` | Prevents full controller eviction during voluntary disruptions. |

## Rollout Plan
1. Add `controllers.podDisruptionBudget` with defaults (disabled).
2. Enable in non-prod and validate node-drain behavior.
3. Enable in prod after confirming controllers can roll without downtime.

Rollback:
- Disable `controllers.podDisruptionBudget.enabled`.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true --set controllers.podDisruptionBudget.enabled=true | rg -n \"kind: PodDisruptionBudget\"
kubectl -n agents get pdb
```

## Failure Modes and Mitigations
- PDB too strict blocks node drain: mitigate with `maxUnavailable: 1` and by matching replicas.
- Selector mismatch means PDB protects nothing: mitigate with render-time tests and explicit selector labels.

## Acceptance Criteria
- When enabled, a PDB exists for `agents-controllers` selecting the correct pods.
- Node drains do not evict all controller replicas at once.

## References
- Kubernetes PodDisruptionBudget: https://kubernetes.io/docs/tasks/run-application/configure-pdb/

