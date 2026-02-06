# Chart Controllers Service (Optional)

Status: Draft (2026-02-06)

## Overview
The controllers Deployment is currently internal-only and has no Service. That is usually fine, but it complicates:
- NetworkPolicy authoring (targeting stable endpoints)
- Debug access to health endpoints (if provided)
- Future webhook endpoints or internal RPC

This doc proposes an optional Service for controllers with a conservative default (disabled).

## Goals
- Provide an opt-in ClusterIP Service for `agents-controllers`.
- Keep default behavior unchanged.

## Non-Goals
- Exposing controllers publicly.

## Current State
- Controllers Deployment exists when `controllers.enabled=true`: `charts/agents/templates/deployment-controllers.yaml`.
- Services exist only for control plane HTTP and optional gRPC:
  - `charts/agents/templates/service.yaml`
  - `charts/agents/templates/service-grpc.yaml`
- No Service selects `agents.controllersSelectorLabels`.

## Design
### Proposed values
Add:
- `controllers.service.enabled` (default `false`)
- `controllers.service.port` (default `8080` if controllers expose HTTP health)
- `controllers.service.annotations` / `labels`

### Selector + ports
- Selector MUST match `agents.controllersSelectorLabels`.
- Port naming should align with container ports if present.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `controllers.service.enabled=false` | none | Current behavior. |
| `controllers.service.enabled=true` | `Service/agents-controllers` | Stable in-cluster endpoint for debug/health as needed. |

## Rollout Plan
1. Add values and template behind disabled default.
2. Enable in non-prod to confirm selector and endpoints.
3. Use as a dependency for any future controller webhooks or debug tooling.

Rollback:
- Disable `controllers.service.enabled`.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true --set controllers.service.enabled=true | rg -n \"kind: Service|agents-controllers\"
kubectl -n agents get svc
kubectl -n agents get endpoints agents-controllers
```

## Failure Modes and Mitigations
- Service selects wrong pods: mitigate with stable selector helpers and render tests.
- Service unintentionally exposed via mesh or gateway defaults: mitigate by ClusterIP default and explicit docs.

## Acceptance Criteria
- Enabling the value renders a Service selecting only controller pods.
- Default install remains unchanged.

## References
- Kubernetes Service type ClusterIP: https://kubernetes.io/docs/concepts/services-networking/service/

