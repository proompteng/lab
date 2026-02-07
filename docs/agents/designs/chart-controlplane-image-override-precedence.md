# Chart Control Plane Image Override Precedence

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
The Agents control plane runs as the `agents` Deployment. The chart supports an explicit `controlPlane.image.*` override separate from `image.*`. This doc defines a contract for selecting that image and recommended promotion paths.

## Goals
- Clarify image selection rules for the control plane.
- Support independent pinning/promotion between control plane and controllers.

## Non-Goals
- Supporting multiple control plane deployments per release.

## Current State
- Template: `charts/agents/templates/deployment.yaml` computes `$imageRepo/$imageTag/$imageDigest` using `controlPlane.image.*` with fallbacks to `image.*`.
- Values: `charts/agents/values.yaml` under `controlPlane.image.*`.
- GitOps pins the control plane image in `argocd/applications/agents/values.yaml`.

## Design
### Precedence for control plane image
1. `controlPlane.image.*` (if field non-empty)
2. `image.*` (root defaults)

### Promotion policy
- Canary controllers first (separate deployment), then promote control plane.
- When changing API behavior that affects CRD reconciliation, promote controllers and control plane in lockstep (same git SHA + digest set).

## Config Mapping
| Helm value | Rendered image for `agents` | Notes |
|---|---|---|
| `controlPlane.image.repository` | repo | Defaults to `image.repository` if empty. |
| `controlPlane.image.tag` | tag | Defaults to `image.tag` if empty. |
| `controlPlane.image.digest` | digest | Defaults to `image.digest` if empty. |
| `controlPlane.image.pullSecrets` | imagePullSecrets | Defaults to `image.pullSecrets` if empty. |

## Rollout Plan
1. Document contract in `charts/agents/README.md`.
2. Add `imagePolicy.requireDigest` enforcement in prod (optional, see `chart-image-digest-tag-precedence.md`).
3. Promote via GitOps value change; wait for rollout status.

Rollback:
- Revert digest and re-sync.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"kind: Deployment|name: agents$|image:\"
kubectl -n agents rollout status deploy/agents
```

## Failure Modes and Mitigations
- Control plane and controllers drift to incompatible versions: mitigate via CI rule enforcing same git SHA tag in prod overlays.
- Digest omitted causes unexpected image pull changes: mitigate with digest enforcement.

## Acceptance Criteria
- Rendered image for `agents` is predictable from values.
- Operators can roll back by reverting a single digest in GitOps.

## References
- Helm best practices for values: https://helm.sh/docs/chart_best_practices/values/

