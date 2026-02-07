# Chart Controllers Image Override Precedence

Status: Draft (2026-02-07)

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
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

