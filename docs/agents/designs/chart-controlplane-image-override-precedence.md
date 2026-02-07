# Chart Control Plane Image Override Precedence

Status: Draft (2026-02-07)

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
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

