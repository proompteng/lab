# Chart Termination Grace + preStop Hook

Status: Draft (2026-02-07)

## Overview
The control plane and controllers handle active requests and ongoing reconciliations. During rollout or node drain, pods should stop accepting new work and drain in-flight tasks before termination. The chart currently does not expose termination grace or preStop hooks.

## Goals
- Add configurable `terminationGracePeriodSeconds`.
- Add optional `preStop` hooks to support graceful shutdown.

## Non-Goals
- Implementing full “drain queues before exit” semantics in the chart alone (requires controller code support).

## Current State
- Templates:
  - `charts/agents/templates/deployment.yaml` and `deployment-controllers.yaml` do not set `terminationGracePeriodSeconds` or lifecycle hooks.
- Runtime shutdown behavior is code-defined and may be abrupt if SIGTERM is not handled carefully:
  - Controllers: `services/jangar/src/server/agents-controller.ts` (shutdown path)
  - Control plane: server entrypoints under `services/jangar/src/server/*`

## Design
### Proposed values
Add:
- `terminationGracePeriodSeconds` (global default)
- `controlPlane.terminationGracePeriodSeconds`
- `controllers.terminationGracePeriodSeconds`
- `controlPlane.lifecycle.preStop`
- `controllers.lifecycle.preStop`

### Recommended defaults
- Control plane: 30s
- Controllers: 60s (to finish reconcile loops)

## Config Mapping
| Helm value | Rendered field | Intended behavior |
|---|---|---|
| `controllers.terminationGracePeriodSeconds` | `deploy/agents-controllers.spec.template.spec.terminationGracePeriodSeconds` | Gives controllers time to stop cleanly. |
| `controlPlane.lifecycle.preStop` | `containers[].lifecycle.preStop` | Stop accepting traffic before termination. |

## Rollout Plan
1. Ship values with conservative defaults.
2. Add controller/control plane logs on SIGTERM (“draining”).
3. Tune grace periods based on observed shutdown times.

Rollback:
- Remove lifecycle settings; Kubernetes defaults apply.

## Validation
```bash
helm template agents charts/agents | rg -n \"terminationGracePeriodSeconds|preStop\"
kubectl -n agents rollout restart deploy/agents
kubectl -n agents rollout restart deploy/agents-controllers
```

## Failure Modes and Mitigations
- Grace period too short causes dropped requests or partial reconciliation: mitigate by conservative defaults and observability of shutdown durations.
- Grace period too long slows rollouts: mitigate by tuning and adding early-drain behavior in code.

## Acceptance Criteria
- Pods drain predictably during rollouts and node drains.
- Termination settings are configurable per component.

## References
- Kubernetes container lifecycle hooks: https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

