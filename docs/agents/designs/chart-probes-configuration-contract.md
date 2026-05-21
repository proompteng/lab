# Chart Probes Configuration Contract

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Overview

The chart exposes HTTP liveness/readiness probes for both components and now supports startup probe configuration, including per-component overrides for control plane and controller deployments.
Each component uses an independent probe contract, so rollout behavior for one Deployment can be changed without affecting the other.

## Goals

- Ensure probes correctly reflect component health.
- Avoid flapping restarts due to aggressive liveness probes.
- Support long startups without false negatives.

## Non-Goals

- Defining SLOs or alerting policies.

## Current State

- Values: `charts/agents/values.yaml` has:
  - global `livenessProbe`, `readinessProbe`, and optional `startupProbe`
  - per-component `controlPlane.*Probe` and `controllers.*Probe` overrides
- Templates:
  - Control plane probes: `charts/agents/templates/deployment.yaml`
  - Controllers probes: `charts/agents/templates/deployment-controllers.yaml`
- Existing global defaults are merged with per-component values; component overrides only replace configured fields.

## Design

### Component-specific probes

The effective values are merged as:

- `globalProbe = merge(deepCopy(.Values.<Probe>), deepCopy(.Values.<component>.<Probe>))`
- Each component uses its merged probe contract (`livenessProbe`, `readinessProbe`, `startupProbe`).
- `controlPlane` and `controllers` are independent contracts, even though they share global defaults by default.

### Defaults

Defaults in `charts/agents/values.yaml`:

- control plane:
  - liveness/readiness inherit global values
  - startup probe inherits global defaults and remains opt-in per component
- controllers:
  - liveness/readiness inherit global values
  - startup probe inherits global defaults and remains opt-in per component

If a component does not expose HTTP health, set component `livenessProbe.enabled` and/or `readinessProbe.enabled` to `false`.

For rollout safety, probe semantics should be changed per component, not globally:

- Start with one component change per release.
- Keep the other Deployment on its prior probe contract until rollout behavior is validated.

## Config Mapping

| Helm value                                          | Rendered probe                                                      | Intended behavior                                      |
| --------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `controlPlane.livenessProbe.*`                      | `deployment.spec.template.containers[0].livenessProbe`              | Control plane liveness semantics.                      |
| `controlPlane.readinessProbe.*`                     | `deployment.spec.template.containers[0].readinessProbe`             | Control plane readiness semantics.                     |
| `controlPlane.startupProbe.*`                       | `deployment.spec.template.containers[0].startupProbe`               | Delay liveness/readiness during cold start.            |
| `controllers.livenessProbe.*`                       | `deployment-controllers.spec.template.containers[0].livenessProbe`  | Controllers liveness semantics.                        |
| `controllers.readinessProbe.*`                      | `deployment-controllers.spec.template.containers[0].readinessProbe` | Controllers readiness semantics.                       |
| `controllers.startupProbe.*`                        | `deployment-controllers.spec.template.containers[0].startupProbe`   | Delay liveness/readiness during controller cold start. |
| `livenessProbe` / `readinessProbe` / `startupProbe` | merge defaults                                                      | Shared defaults when component overrides are omitted.  |

## Rollout Plan

1. For rollback compatibility, keep component override objects empty unless customization is required.
2. Verify controller HTTP probe behavior before enabling probes in environments that serve non-HTTP workloads.
3. Enable component startup probes only when startup/recoverability data indicates a clear benefit.
4. Tune thresholds based on observed rollout behavior.

Rollback:

- Remove component overrides and rely on existing global probes.
- If startup probes were introduced during rollout hardening, set both startup probes back to `enabled: false`.

### Migration behavior

- Roll out startup probes one component at a time to avoid simultaneous probe-contract changes.
- `startupProbe` is additive: liveness/readiness defaults remain unchanged unless you also modify those blocks.
- For rollback, disable component startup probes first and remove timing overrides second.

Tradeoffs:

- Enabling `startupProbe` reduces restart storms for slow startups, but too-high values can delay rollout completion and mask startup regressions.
- `initialDelaySeconds`/`failureThreshold` on liveness/readiness trade off crash detection speed vs false-positive restarts.
- Running startup and liveness/readiness probes simultaneously with aggressive settings can over-load endpoints during burst traffic.

### Per-component migration semantics

- Probe contracts are rendered independently for `Deployment/agents` and `Deployment/agents-controllers`.
- Prefer staged rollout when changing probe timing:
  1. Enable a startup probe on only one component first.
  2. Observe rollout behavior and restart duration.
  3. Apply the same change to the second component only if the first remains healthy.
- On rollback, disable startup probes on the first modified component before changing global or second-component settings.

## Validation

```bash
helm template agents charts/agents | rg -n \"livenessProbe:|readinessProbe:|startupProbe:\"
kubectl -n agents describe pod -l app.kubernetes.io/name=agents | rg -n \"Liveness|Readiness|Startup\"
```

## Failure Modes and Mitigations

- Liveness probe too strict causes restart loops: mitigate with startupProbe + relaxed thresholds.
- Readiness probe too lax sends traffic to an unready control plane: mitigate by tying readiness to dependency checks in code.

## Acceptance Criteria

- Control plane and controllers can be configured independently.
- StartupProbe prevents false liveness failures during initialization.

## References

- Kubernetes probes: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
