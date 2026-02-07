# Chart Resources: Component Overrides

Status: Draft (2026-02-07)
## Overview
The Agents chart exposes `resources` as a global default and also supports component-specific overrides (`controlPlane.resources`, `controllers.resources`). These overrides are implemented in templates but not explicitly documented, which increases the chance of accidentally starving controllers or the control plane in production.

## Goals
- Document the current override behavior and make it explicit.
- Recommend production defaults for control plane vs controllers.
- Ensure resource settings are observable via Helm render and `kubectl`.

## Non-Goals
- Autosizing resources automatically.
- Changing scheduling/affinity policies (handled separately).

## Current State
- Values:
  - Global: `charts/agents/values.yaml` → `resources`
  - Control plane override: `charts/agents/values.yaml` → `controlPlane.resources`
  - Controllers override: `charts/agents/values.yaml` → `controllers.resources`
- Template wiring:
  - Control plane uses `$resources := .Values.controlPlane.resources | default .Values.resources` in `charts/agents/templates/deployment.yaml`.
  - Controllers uses `$resources := .Values.controllers.resources | default .Values.resources` in `charts/agents/templates/deployment-controllers.yaml`.
- Cluster desired state sets `resources.requests` globally in `argocd/applications/agents/values.yaml` but does not set per-component overrides.

## Design
### Contract
- If a component override is an empty object (`{}`), it is treated as “unset” and the component inherits from global `resources`.
- Production guidance:
  - Controllers should have explicit requests/limits tuned for reconcile throughput.
  - Control plane should have explicit requests/limits tuned for serving traffic and background tasks.

### Recommended chart documentation
Add a chart README section:
- “Resource precedence” with examples showing:
  - Global only
  - Controllers-only override
  - Control-plane-only override

## Config Mapping
| Helm value | Pod resources target | Behavior |
|---|---|---|
| `resources` | `deploy/agents` and `deploy/agents-controllers` | Baseline default for all components. |
| `controlPlane.resources` | `deploy/agents` | Overrides global for control plane only. |
| `controllers.resources` | `deploy/agents-controllers` | Overrides global for controllers only. |

## Rollout Plan
1. Document precedence (no behavior change).
2. In GitOps, set explicit per-component requests for production.
3. Add alerting to catch CPU throttling / OOMKilled during canary (operational follow-up).

Rollback:
- Revert values changes; chart behavior remains backward compatible.

## Validation
```bash
mise exec helm@3 -- helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"resources:|requests:|limits:\"
kubectl -n agents get deploy agents -o yaml | rg -n \"resources:\"
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"resources:\"
```

## Failure Modes and Mitigations
- Controllers starve and fall behind: mitigate by explicit controller requests and by monitoring reconcile lag.
- Control plane throttles under API load: mitigate by explicit control plane requests and HPA (if enabled).
- Values changes accidentally apply to both components: mitigate by using component overrides and validating rendered manifests.

## Acceptance Criteria
- Documentation clearly explains precedence and examples.
- Production GitOps values can size controllers separately from the control plane.

## References
- Kubernetes resource requests/limits: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
