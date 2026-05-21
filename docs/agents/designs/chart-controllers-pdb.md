# Chart Controllers PodDisruptionBudget

Status: Implemented (2026-03-01)

Docs index: [README](../README.md)

## Overview

The chart can deploy a separate controllers Deployment (`agents-controllers`), and it now renders PDBs for both the control plane and controllers when configured.

## Goals

- Add optional PDB support for `agents-controllers`.
- Keep backward compatibility for existing installs using `podDisruptionBudget.*`.
- Expose controller rollout strategy controls so controller upgrade behavior can be made
  disruption-safe independently from the control plane.

## Non-Goals

- Enforcing a single organization-wide disruption policy.

## Current State

- Existing PDB template: `charts/agents/templates/poddisruptionbudget.yaml`
  - Selects `{{ include "agents.selectorLabels" . }}` (control plane).
- The same template also renders `agents-controllers` PDBs when
  `controllers.enabled=true` and `controllers.podDisruptionBudget.enabled=true`,
  selecting with `{{ include "agents.controllersSelectorLabels" . }}` from `charts/agents/templates/_helpers.tpl`.
- Values: `charts/agents/values.yaml` now supports:
  - `podDisruptionBudget.*` for control plane (backward-compatible),
  - `controllers.podDisruptionBudget.*` for controllers.
- `controllers.deploymentStrategy` now maps to optional `Deployment.spec.strategy`
  for `Deployment/agents-controllers`.
- Cluster desired state: `argocd/applications/agents/values.yaml` does not enable a PDB.

## Design

### Proposed values

Add component-scoped PDBs:

- `podDisruptionBudget` for control plane (existing key, backward-compatible)
- `controllers.podDisruptionBudget` for controllers (new)
- `controllers.deploymentStrategy` for controller rollout behavior (new)

### Defaults

- Keep existing `podDisruptionBudget.enabled=false`.
- When controllers are enabled, recommend enabling a PDB with `maxUnavailable: 1` for controllers.
- For rollout safety, pair replicas/PDB with:
  - `controllers.deploymentStrategy.type=RollingUpdate`
  - `controllers.deploymentStrategy.rollingUpdate.maxUnavailable=0`
  - `controllers.deploymentStrategy.rollingUpdate.maxSurge=1`

## Config Mapping

| Helm value                                     | Rendered object                          | Intended behavior                                               |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| `podDisruptionBudget.*`                        | `PodDisruptionBudget/agents`             | Backward compatible control plane PDB.                          |
| `controllers.podDisruptionBudget.enabled=true` | `PodDisruptionBudget/agents-controllers` | Prevents full controller eviction during voluntary disruptions. |
| `controllers.deploymentStrategy`               | `Deployment/agents-controllers.spec`     | Optional rollout strategy controls when configured.             |

## Rollout Plan

1. ✅ Add `controllers.podDisruptionBudget` with defaults (disabled).
2. ✅ Add `controllers.deploymentStrategy` for rollout-specific controller controls.
3. ✅ Validate local/prod chart render and selector behavior.
4. Enable in production overlays after confirming rollout safety.

Rollback:

- Disable `controllers.podDisruptionBudget.enabled`.

## Validation

```bash
helm template agents charts/agents --set controllers.enabled=true --set controllers.podDisruptionBudget.enabled=true | rg -n \"kind: PodDisruptionBudget\"
kubectl -n agents get pdb

helm template agents charts/agents --set controllers.enabled=true --set controllers.deploymentStrategy.type=RollingUpdate --set controllers.deploymentStrategy.rollingUpdate.maxUnavailable=0 --set controllers.deploymentStrategy.rollingUpdate.maxSurge=1 | rg -n \"kind: Deployment\"
```

## Failure Modes and Mitigations

- PDB too strict blocks node drain: mitigate with `maxUnavailable: 1` and by matching replicas.
- Selector mismatch means PDB protects nothing: mitigate with render-time tests and explicit selector labels.
- Overly strict rollout settings can block upgrades: validate rollout commands in non-prod before rollout.

## Acceptance Criteria

- When enabled, a PDB exists for `agents-controllers` selecting the correct pods.
- Node drains do not evict all controller replicas at once.
- When configured, `Deployment/agents-controllers` includes `spec.strategy` from
  `controllers.deploymentStrategy`.

## References

- Kubernetes PodDisruptionBudget: https://kubernetes.io/docs/tasks/run-application/configure-pdb/
