# Chart Controllers HorizontalPodAutoscaler

Status: Draft (2026-02-07)
## Overview
The chart’s HPA template targets only the control plane Deployment (`agents`). Controllers are deployed as a separate Deployment (`agents-controllers`) but do not have autoscaling support. Controllers workload is often bursty (reconcile storms, webhook bursts), and lack of scaling can cause backlog and delayed reconciliation.

## Goals
- Add optional HPA support for `agents-controllers`.
- Keep existing `autoscaling.*` behavior unchanged for the control plane.

## Non-Goals
- Implementing custom metrics autoscaling in this phase.

## Current State
- Existing HPA template: `charts/agents/templates/hpa.yaml`
  - Targets `Deployment/{{ include "agents.fullname" . }}` only.
- Values: `charts/agents/values.yaml` exposes a single `autoscaling.*`.
- Controllers deployment: `charts/agents/templates/deployment-controllers.yaml`.

## Design
### Proposed values
Add:
- `controllers.autoscaling` (new)

### Defaults
- `controllers.autoscaling.enabled=false`
- Recommend `minReplicas: 1`, `maxReplicas: 3` initially, CPU-based scaling only.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `autoscaling.*` | `HPA/agents` | Control plane HPA (existing). |
| `controllers.autoscaling.enabled=true` | `HPA/agents-controllers` | Scales controllers Deployment based on CPU/memory. |

## Rollout Plan
1. Add new `controllers.autoscaling` keys with defaults disabled.
2. Enable in non-prod and validate scale-up/down behavior.
3. Enable in prod after ensuring PDB/strategy supports scaling safely.

Rollback:
- Disable `controllers.autoscaling.enabled`.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true --set controllers.autoscaling.enabled=true | rg -n \"kind: HorizontalPodAutoscaler\"
kubectl -n agents get hpa
```

## Failure Modes and Mitigations
- HPA scales down too aggressively and loses in-flight work: mitigate with conservative scale-down policies and controller graceful shutdown.
- HPA not created due to missing metrics server: mitigate by documenting prerequisites and keeping disabled by default.

## Acceptance Criteria
- When enabled, `agents-controllers` has an HPA targeting the correct Deployment.
- Operators can scale controllers independently of the control plane.

## References
- Kubernetes HPA v2: https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
