# Chart Deployment Strategy: RollingUpdate Tuning

Status: Draft (2026-02-07)

## Overview
The chart currently relies on Kubernetes default `RollingUpdate` behavior for Deployments. For production, we should explicitly control surge/unavailable and optionally support safer strategies (e.g. `Recreate` for DB-migration-sensitive components).

## Goals
- Provide explicit, chart-configurable Deployment strategies for:
  - `deploy/agents`
  - `deploy/agents-controllers`
- Enable safe canary/rollback patterns with predictable availability.

## Non-Goals
- Replacing GitOps rollout control (Argo CD) with Helm hooks.

## Current State
- Templates:
  - Control plane Deployment: `charts/agents/templates/deployment.yaml` has no `spec.strategy`.
  - Controllers Deployment: `charts/agents/templates/deployment-controllers.yaml` has no `spec.strategy`.
- Values: no strategy knobs exist in `charts/agents/values.yaml`.

## Design
### Proposed values
Add:
- `controlPlane.deploymentStrategy`
- `controllers.deploymentStrategy`
- `deploymentStrategy` (global default)

Each can accept:
```yaml
type: RollingUpdate
rollingUpdate:
  maxSurge: 25%
  maxUnavailable: 0
```

### Defaults
- Control plane:
  - `maxUnavailable: 0` (prefer availability)
- Controllers:
  - `maxUnavailable: 1` (prefer continuity but allow roll)

## Config Mapping
| Helm value | Rendered field | Intended behavior |
|---|---|---|
| `deploymentStrategy` | `Deployment.spec.strategy` | Global default used if component overrides are absent. |
| `controlPlane.deploymentStrategy` | `deploy/agents.spec.strategy` | Component-specific override. |
| `controllers.deploymentStrategy` | `deploy/agents-controllers.spec.strategy` | Component-specific override. |

## Rollout Plan
1. Add new values with conservative defaults matching Kubernetes defaults (no behavior change).
2. In production, set explicit `maxUnavailable`/`maxSurge` values.
3. Validate rollout behavior during a canary image bump.

Rollback:
- Remove values; cluster falls back to defaults.

## Validation
```bash
helm template agents charts/agents | rg -n \"strategy:\"
kubectl -n agents get deploy agents -o yaml | rg -n \"strategy:\"
kubectl -n agents rollout status deploy/agents
```

## Failure Modes and Mitigations
- Too aggressive `maxUnavailable` causes downtime: mitigate by defaulting to `0` for control plane.
- Surge causes resource pressure: mitigate by setting explicit `maxSurge` and sizing cluster capacity.

## Acceptance Criteria
- Operators can tune rollout availability without editing templates.
- Both Deployments render with explicit strategy when configured.

## References
- Kubernetes Deployment strategy: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

