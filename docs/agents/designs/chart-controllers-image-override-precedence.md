# Chart Controllers Image Override Precedence

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
The Agents chart can run controllers as a separate Deployment (`agents-controllers`) with its own image. Operators need a clear contract for how `controllers.image.*` relates to the root `image.*` and the control plane `controlPlane.image.*`.

## Goals
- Define image selection precedence for `agents-controllers`.
- Enable safe canarying controllers independently from the control plane.

## Non-Goals
- Supporting multiple controller images in a single release (one deployment only).

## Current State
- Controllers deployment template: `charts/agents/templates/deployment-controllers.yaml` computes:
  - `$imageRepo := .Values.controllers.image.repository | default .Values.image.repository`
  - similarly for `tag`, `digest`, `pullPolicy`, `pullSecrets`
- Values surface: `charts/agents/values.yaml` under `controllers.image.*` and `image.*`.
- GitOps currently pins both control plane and controller images in `argocd/applications/agents/values.yaml`.

## Design
### Precedence for controllers
1. `controllers.image.*` (if field non-empty)
2. `image.*` (root defaults)

### Operational policy
- For production: always set `controllers.image.digest` explicitly when `controllers.enabled=true`.
- For canary: bump controllers digest first, validate, then bump control plane digest.

## Config Mapping
| Helm value | Rendered image for `agents-controllers` | Notes |
|---|---|---|
| `controllers.image.repository` | repo | Defaults to `image.repository` if empty. |
| `controllers.image.tag` | tag | Defaults to `image.tag` if empty. |
| `controllers.image.digest` | digest | Defaults to `image.digest` if empty. |
| `controllers.image.pullSecrets` | imagePullSecrets | Defaults to `image.pullSecrets` if empty. |

## Rollout Plan
1. Add this contract to `charts/agents/README.md`.
2. Add a CI check that `controllers.enabled=true` implies `controllers.image.digest` is non-empty in prod overlays.
3. Use an Argo CD canary window (manual sync or progressive wave) before promoting.

Rollback:
- Revert `controllers.image.digest` to the prior known-good digest and re-sync.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"name: agents-controllers|image:\"
kubectl -n agents get deploy agents-controllers -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

## Failure Modes and Mitigations
- Controllers image accidentally inherits `image.tag=latest` without digest: mitigate via validation/enforcement in prod.
- Canary controllers uses incompatible schema vs CRDs: mitigate by bundling CRD changes + controllers changes in one PR when APIs change.

## Acceptance Criteria
- Operators can canary `agents-controllers` without modifying the control plane deployment.
- A prod overlay policy ensures controllers run by digest, not mutable tags.

## References
- Kubernetes container images: https://kubernetes.io/docs/concepts/containers/images/

