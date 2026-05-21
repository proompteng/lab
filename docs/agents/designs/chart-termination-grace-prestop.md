# Chart Termination Grace + preStop Hook

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Overview

The control plane and controllers handle active requests and ongoing reconciliations. During rollout or node drain, pods should stop accepting new work and drain in-flight tasks before termination.
The chart now exposes termination grace-period and lifecycle hook controls at global and per-component levels.

## Goals

- Add configurable `terminationGracePeriodSeconds`.
- Add optional `preStop` hooks to support graceful shutdown.

## Non-Goals

- Implementing full “drain queues before exit” semantics in the chart alone (requires controller code support).

## Current State

- Templates:
  - `charts/agents/templates/deployment.yaml` and `deployment-controllers.yaml` now set:
    - `terminationGracePeriodSeconds`
    - `lifecycle` (`preStop`, etc.)
  - Rendering uses per-component values first (`controlPlane.*`, `controllers.*`) and then falls back to global defaults (`terminationGracePeriodSeconds`, `lifecycle`).
- Runtime shutdown behavior is code-defined and may be abrupt if SIGTERM is not handled carefully:
  - Controllers: `services/agents/src/server/agents-controller` (shutdown path)
  - Control plane: server entrypoints under `services/agents/src/server/*`

## Design

### Implemented values

Added keys:

- `terminationGracePeriodSeconds` (global default)
- `controlPlane.terminationGracePeriodSeconds`
- `controllers.terminationGracePeriodSeconds`
- `controlPlane.lifecycle`
- `controllers.lifecycle`
- `deploymentLifecycle` (global defaults for rollout/upgrade timing)
- `controlPlane.deploymentLifecycle`
- `controllers.deploymentLifecycle`

### Recommended defaults

- Control plane: 30s
- Controllers: 60s (to finish reconcile loops)

Control plane uses global defaults by default and can be overridden via `controlPlane.terminationGracePeriodSeconds`.

## Config Mapping

| Helm value                                   | Rendered field                                                                                                                                                    | Intended behavior                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `controlPlane.terminationGracePeriodSeconds` | `deploy/agents.spec.template.spec.terminationGracePeriodSeconds`                                                                                                  | Gives control plane time to stop cleanly.                        |
| `controllers.terminationGracePeriodSeconds`  | `deploy/agents-controllers.spec.template.spec.terminationGracePeriodSeconds`                                                                                      | Gives controllers time to stop cleanly.                          |
| `deploymentLifecycle`                        | `deploy/agents.spec.minReadySeconds`, `deploy/agents.spec.progressDeadlineSeconds`, `deploy/agents.spec.revisionHistoryLimit` (and equivalent in controllers)     | Global rollout timing defaults for upgrade safety.               |
| `controlPlane.deploymentLifecycle`           | `deploy/agents.spec.minReadySeconds`, `deploy/agents.spec.progressDeadlineSeconds`, `deploy/agents.spec.revisionHistoryLimit`                                     | Control plane rollout timing override.                           |
| `controllers.deploymentLifecycle`            | `deploy/agents-controllers.spec.minReadySeconds`, `deploy/agents-controllers.spec.progressDeadlineSeconds`, `deploy/agents-controllers.spec.revisionHistoryLimit` | Controllers rollout timing override.                             |
| `controlPlane.lifecycle`                     | `deploy/agents.spec.template.spec.containers[0].lifecycle`                                                                                                        | Supports optional `preStop` and related hooks for control plane. |
| `controllers.lifecycle`                      | `deploy/agents-controllers.spec.template.spec.containers[0].lifecycle`                                                                                            | Supports optional `preStop` and related hooks for controllers.   |

## Rollout Plan

1. Ship values with explicit lifecycle/shutdown defaults:
   - global termination grace period is set in `values.yaml`
   - controllers keep a longer default (`60`) for reconcile-heavy workloads
   - hooks remain unset until a rollout proves shutdown paths are safe
2. Add controller/control plane logs on SIGTERM (“draining”) in application code as needed.
3. Tune grace periods and hooks based on observed shutdown times.

### Deployment lifecycle migration

- Use staged rollout by component:
  1. Set global `deploymentLifecycle` changes first (for both components).
  2. Apply component-specific lifecycle changes to the least-critical component first.
  3. Apply to the second component only after rollout completes and healthy.
- If probes or drains misbehave, rollback in the reverse order:
  1. Remove component `deploymentLifecycle` overrides.
  2. Remove component `lifecycle` overrides.
  3. Revert global `deploymentLifecycle`.

Tradeoffs:

- Larger `terminationGracePeriodSeconds` improves graceful draining but increases rollout/scale-down time.
- `preStop` hooks can reduce request/reconcile loss, but hooks that run too long can delay pod replacement and consume termination budget.
- Different grace windows for control plane vs controllers is usually useful: controllers often need a longer window to finish reconcilers while control plane can return faster.

### Migration behavior

- For upgrade/drain safety you can phase in shutdown behavior:
  1. Start with global `terminationGracePeriodSeconds` only (control plane and controllers inherit this baseline).
  2. Add controller-specific override only after validating controller graceful behavior in rollouts.
  3. Add control-plane-specific override only after controllers are stable.
- On rollback, remove lifecycle hooks first (or clear them to `{}`) before lowering grace periods.

Rollback:

- Remove `terminationGracePeriodSeconds` and lifecycle blocks to fall back to Kubernetes defaults.
- Keep `lifecycle` empty (`{}`) if only graceful shutdown is being phased out before removing keys.

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
