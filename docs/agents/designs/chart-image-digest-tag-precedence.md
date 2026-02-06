# Chart Image Digest/Tag Precedence

Status: Draft (2026-02-06)

## Overview
The Agents chart supports image tags and optional digests for both the control plane and controllers. In production GitOps, digests are preferred for immutability. The chart currently concatenates `repo:tag@digest` when a digest is provided, but the operational contract (and failure modes) are not documented.

## Goals
- Define a clear contract for tag + digest usage.
- Prevent accidental drift (e.g. `tag: latest` without digest).
- Provide a safe upgrade/rollback process.

## Non-Goals
- Introducing an image signing/verification system (covered elsewhere).

## Current State
- Values: `charts/agents/values.yaml` under `image.*`, `controlPlane.image.*`, `controllers.image.*`.
- Template image rendering:
  - Control plane: `charts/agents/templates/deployment.yaml`
  - Controllers: `charts/agents/templates/deployment-controllers.yaml`
- GitOps pins digests in `argocd/applications/agents/values.yaml`.

## Design
### Rendering rules
- If `digest` is non-empty: render `repository:tag@digest`.
- If `digest` is empty: render `repository:tag`.
- Component-specific image blocks override the root `image.*` values for that component.

### Production policy
- Production profiles MUST set `digest` for all images.
- `tag` remains required even when digest is set (for readability), but it is informational-only.

### Chart validation
Add optional enforcement:
- `imagePolicy.requireDigest=true` (default `false`): when enabled, render fails if any enabled component lacks a digest.

## Config Mapping
| Helm value | Rendered field | Behavior |
|---|---|---|
| `image.repository` | `spec.template.spec.containers[].image` | Default repository for control plane and (if unset) controllers. |
| `image.tag` | image string | Used when digest is absent; informational when digest is present. |
| `image.digest` | image string | If set, pins an immutable manifest. |
| `controlPlane.image.*` | control plane image string | Overrides root `image.*`. |
| `controllers.image.*` | controllers image string | Overrides root `image.*`. |

## Rollout Plan
1. Add documentation + schema keys (no behavior change).
2. Enable `imagePolicy.requireDigest=true` in non-prod first.
3. Enable in prod after verifying image promotion pipeline always supplies digests.

Rollback:
- Disable `imagePolicy.requireDigest`.
- Roll back values to prior digests; no template changes required.

## Validation
Render:
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"image:|@sha256:\"
```

Live:
```bash
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl -n agents get deploy agents-controllers -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

## Failure Modes and Mitigations
- Digest set with wrong tag: safe (digest wins); mitigate confusion by documenting tag informational-only.
- Digest omitted in prod: mitigate via enforcement flag and CI checks on GitOps values.
- Registry garbage-collects unreferenced manifests: mitigate by retaining digests used in GitOps history.

## Acceptance Criteria
- Production values pin digests for all enabled components.
- Optional chart enforcement can be turned on without code changes.

## References
- Kubernetes container image names (tag/digest): https://kubernetes.io/docs/concepts/containers/images/

