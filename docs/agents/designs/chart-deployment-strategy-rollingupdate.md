# Chart Deployment Strategy: RollingUpdate Tuning

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Overview

The chart now supports explicit Deployment strategy configuration at both component levels.
Rollout decisions are component-scoped so control plane and controllers can be tuned independently during staged migrations.

## Goals

- Provide explicit, chart-configurable Deployment strategies for:
  - `deploy/agents`
  - `deploy/agents-controllers`
- Enable safe canary/rollback patterns with predictable availability.

## Non-Goals

- Replacing GitOps rollout control (Argo CD) with Helm hooks.

## Current State

- Templates:
  - Control plane Deployment: `charts/agents/templates/deployment.yaml` renders `spec.strategy` from merged strategy values.
  - Controllers Deployment: `charts/agents/templates/deployment-controllers.yaml` renders `spec.strategy` from merged strategy values.
- Values:
  - `charts/agents/values.yaml` now sets baseline defaults under `deploymentStrategy`.
  - `controlPlane.deploymentStrategy` and `controllers.deploymentStrategy` remain available for component-specific overrides.
  - `deploymentLifecycle` and per-component `deploymentLifecycle` keys now expose rollout lifecycle knobs (`minReadySeconds`, `progressDeadlineSeconds`, `revisionHistoryLimit`) for safer upgrades.

## Design

### Implemented values

Control:

- `controlPlane.deploymentStrategy`
- `controllers.deploymentStrategy`
- `deploymentStrategy` (global default)

Deployment strategy values accept the same object structure as Kubernetes `spec.strategy`, and are merged as global defaults from `deploymentStrategy` overridden by component-specific fields (`controlPlane.deploymentStrategy` / `controllers.deploymentStrategy`).

Deployment lifecycle values also merge with the same precedence:

- global `deploymentLifecycle` first, then component-level overrides.

Example:

```yaml
type: RollingUpdate
rollingUpdate:
  maxSurge: 1
  maxUnavailable: 0
```

### Baseline defaults (current chart defaults)

Current chart defaults:

```yaml
deploymentStrategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0

deploymentLifecycle:
  minReadySeconds: 0
  progressDeadlineSeconds: 600
  revisionHistoryLimit: 10
```

Component-specific override behavior:

- To change control-plane rollout behavior without affecting controllers, set `controlPlane.deploymentStrategy`.
- To change controller rollout behavior without affecting control plane, set `controllers.deploymentStrategy`.

#### Migration behavior

- This chart release renders an explicit `spec.strategy` block for both Deployments by default.
- If a cluster cannot absorb `maxSurge: 1`, temporarily set:
  ```yaml
  deploymentStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 0
  ```
- Use component overrides only when operational intent differs:
  - `controlPlane.deploymentStrategy` for control-plane rollout semantics.
  - `controllers.deploymentStrategy` for controller rollout semantics.
- For upgrade safety, control rollout timing first and strategy second:
  1. Set global `deploymentStrategy` if needed.
  2. Set global `deploymentLifecycle` when rollout windows need explicit progress deadlines.
  3. Add component-specific overrides only for the component under migration.
  4. Repeat for the second component only after observing healthy rollout.

Rollback order:

- Remove per-component `deploymentStrategy`/`deploymentLifecycle` overrides first.
- Revert global values second.
- Then rollout a full rollback to restore previous behavior.

Tradeoffs:

- `maxUnavailable: 0` keeps control-plane availability high and is safer by default, but increases rollout duration.
- `maxSurge: 1` speeds rollouts while usually staying within capacity; raise cautiously on constrained clusters.
- Larger `progressDeadlineSeconds` helps long rollouts succeed but delays rollback signaling for stalled deployments.
- Higher `revisionHistoryLimit` improves rollback/debug options but increases object history storage.

Recommended staged order:

1. Set/verify global `deploymentStrategy` first.
2. If needed, roll out control-plane strategy/lifecycle override only.
3. Apply controllers strategy/lifecycle override only after control-plane behavior is observed stable.

## Config Mapping

| Helm value                         | Rendered field                                                                                                                                                    | Intended behavior                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `deploymentStrategy`               | `Deployment.spec.strategy`                                                                                                                                        | Global default used if component overrides are absent. |
| `controlPlane.deploymentStrategy`  | `deploy/agents.spec.strategy`                                                                                                                                     | Component-specific override.                           |
| `controllers.deploymentStrategy`   | `deploy/agents-controllers.spec.strategy`                                                                                                                         | Component-specific override.                           |
| `deploymentLifecycle`              | `Deployment.spec.minReadySeconds`, `Deployment.spec.progressDeadlineSeconds`, `Deployment.spec.revisionHistoryLimit`                                              | Global rollout lifecycle defaults.                     |
| `controlPlane.deploymentLifecycle` | `deploy/agents.spec.minReadySeconds`, `deploy/agents.spec.progressDeadlineSeconds`, `deploy/agents.spec.revisionHistoryLimit`                                     | Control-plane-specific lifecycle override.             |
| `controllers.deploymentLifecycle`  | `deploy/agents-controllers.spec.minReadySeconds`, `deploy/agents-controllers.spec.progressDeadlineSeconds`, `deploy/agents-controllers.spec.revisionHistoryLimit` | Controllers-specific lifecycle override.               |

## Rollout Plan

1. Add rollout defaults/overrides in a values-only change first.
2. Verify rollout with a canary image change.
3. Tune per-component overrides over two releases (global first, then component-specific).

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
