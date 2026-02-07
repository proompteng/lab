# Chart Pod Annotations Merging

Status: Draft (2026-02-07)

## Overview
The chart applies `.Values.podAnnotations` and `.Values.podLabels` to both the control plane pod template and the controllers pod template. Operators often need different annotations per component (e.g., different scraping, sidecar settings, or rollout controls). Today that requires global annotations that may not be appropriate for both.

## Goals
- Define current behavior and its limits.
- Propose component-scoped pod metadata overrides without breaking existing installs.

## Non-Goals
- Standardizing on a specific mesh/observability stack.

## Current State
- Values: `charts/agents/values.yaml` includes `podAnnotations` and `podLabels` (global).
- Templates:
  - Control plane pod template: `charts/agents/templates/deployment.yaml`
  - Controllers pod template: `charts/agents/templates/deployment-controllers.yaml`
- No `controlPlane.podAnnotations` / `controllers.podAnnotations` values exist.

## Design
### Proposed values
Add component-scoped fields:
- `controlPlane.podAnnotations` / `controlPlane.podLabels`
- `controllers.podAnnotations` / `controllers.podLabels`

### Precedence
1. Component-scoped annotations/labels (if set)
2. Global `podAnnotations` / `podLabels`

### Backward compatibility
- Keep global keys working unchanged.
- Implement component keys as additive overrides.

## Config Mapping
| Helm value | Pod template target | Behavior |
|---|---|---|
| `podAnnotations` | both Deployments | Global baseline annotations. |
| `controlPlane.podAnnotations` | `deploy/agents` only | Overrides/extends globals for control plane. |
| `controllers.podAnnotations` | `deploy/agents-controllers` only | Overrides/extends globals for controllers. |

## Rollout Plan
1. Add new values keys with no defaults (no behavior change).
2. Update `values.schema.json` and README examples.
3. Migrate any component-specific annotations from global to component keys in GitOps.

Rollback:
- Remove component keys and move annotations back to global.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"annotations:\"
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.metadata.annotations}'; echo
kubectl -n agents get deploy agents-controllers -o jsonpath='{.spec.template.metadata.annotations}'; echo
```

## Failure Modes and Mitigations
- Global annotation breaks controllers (or control plane): mitigate by component scoping.
- Annotation changes do not trigger rollout: mitigate via checksum annotations (see separate design).

## Acceptance Criteria
- Component-scoped pod metadata can be set without affecting the other component.
- Backward compatibility: existing installs using `podAnnotations` continue to work.

## References
- Kubernetes pod template metadata: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

