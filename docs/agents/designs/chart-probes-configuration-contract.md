# Chart Probes Configuration Contract

Status: Draft (2026-02-06)

## Overview
The chart exposes HTTP liveness/readiness probe settings for the control plane, but probes may not be appropriate for controllers (which may not expose HTTP) and there is no startup probe for long initialization (e.g., cache warmup).

This doc defines probe semantics per component and proposes adding startup probes and per-component overrides.

## Goals
- Ensure probes correctly reflect component health.
- Avoid flapping restarts due to aggressive liveness probes.
- Support long startups without false negatives.

## Non-Goals
- Defining SLOs or alerting policies.

## Current State
- Values: `charts/agents/values.yaml` has `livenessProbe` and `readinessProbe`.
- Templates:
  - Control plane probes: `charts/agents/templates/deployment.yaml` (HTTP GET to `.Values.*Probe.path` on `port: http`).
  - Controllers probes: currently inherited similarly (if present) depending on the template structure in `deployment-controllers.yaml` (needs explicit review when adding).
- No startupProbe values exist.

## Design
### Component-specific probes
Add:
- `controlPlane.livenessProbe`, `controlPlane.readinessProbe`, `controlPlane.startupProbe`
- `controllers.livenessProbe`, `controllers.readinessProbe`, `controllers.startupProbe`

### Defaults
- Control plane:
  - readiness: `/health` (existing)
  - liveness: `/health` (existing)
  - startup: enabled with higher thresholds to tolerate migrations/cold start
- Controllers:
  - Prefer a simple HTTP `/health` endpoint if available; otherwise allow exec-based probe or disable probes explicitly.

## Config Mapping
| Helm value | Rendered probe | Intended behavior |
|---|---|---|
| `controlPlane.readinessProbe.path` | readinessProbe.httpGet.path | Control plane only. |
| `controllers.startupProbe.*` | startupProbe (http/exec) | Prevent premature restarts during controller initialization. |

## Rollout Plan
1. Add new component probe keys; default them to current global values for control plane.
2. Verify controllers have a stable health endpoint (or disable probes explicitly).
3. Tune thresholds based on observed rollout behavior.

Rollback:
- Remove component overrides and rely on existing global probes.

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

