# Chart gRPC Enabled: Single Source of Truth

Status: Draft (2026-02-06)

## Overview
The chart has `grpc.enabled` (controls Service + container port) while runtime can also be toggled with `JANGAR_GRPC_ENABLED` (via `env.vars`). When these disagree, the deployment can become confusing: a Service may exist without the server listening, or the server may listen without a Service/port.

This doc defines a single-source-of-truth contract.

## Goals
- Ensure `grpc.enabled` and `JANGAR_GRPC_ENABLED` cannot drift.
- Provide a safe migration path for existing installs.

## Non-Goals
- Changing the gRPC API surface area.

## Current State
- Chart:
  - Service template: `charts/agents/templates/service-grpc.yaml` gated on `grpc.enabled`.
  - Container port for gRPC is gated on `grpc.enabled`: `charts/agents/templates/deployment.yaml`.
  - Controllers deployment defaults `JANGAR_GRPC_ENABLED=0`: `charts/agents/templates/deployment-controllers.yaml`.
- GitOps:
  - `argocd/applications/agents/values.yaml` sets `grpc.enabled: true` and also sets `JANGAR_GRPC_ENABLED: \"true\"` under `env.vars`.

## Design
### Contract
- `grpc.enabled` MUST be the only control-plane switch.
- The chart MUST render `JANGAR_GRPC_ENABLED` for the control plane based on `grpc.enabled` (and ignore user-provided overrides unless explicitly allowed).
- Controllers deployment MUST continue to default-disable gRPC unless there is a concrete use-case.

### Migration
- Introduce `grpc.manageEnvVar` (default `true`):
  - When `true`, template sets `JANGAR_GRPC_ENABLED` from `grpc.enabled`.
  - When `false`, chart does not set it and operators can manage it manually.

## Config Mapping
| Helm value | Rendered env var / object | Intended behavior |
|---|---|---|
| `grpc.enabled=true` | `Service/agents-grpc` + `containerPort: grpc` + `JANGAR_GRPC_ENABLED=1` | Server listens and is reachable via Service. |
| `grpc.enabled=false` | no gRPC Service/port + `JANGAR_GRPC_ENABLED=0` | Server does not expose/listen. |

## Rollout Plan
1. Add `grpc.manageEnvVar` default `true`, but accept existing `env.vars.JANGAR_GRPC_ENABLED` with a warning (no failure).
2. Update GitOps values to remove redundant `JANGAR_GRPC_ENABLED`.
3. After a canary, enforce: render fails if `grpc.manageEnvVar=true` and user sets `JANGAR_GRPC_ENABLED`.

Rollback:
- Set `grpc.manageEnvVar=false` and restore explicit env var management.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"agents-grpc|containerPort: grpc|JANGAR_GRPC_ENABLED\"
kubectl -n agents get svc agents-grpc
kubectl -n agents get endpointslice -l app.kubernetes.io/name=agents
```

## Failure Modes and Mitigations
- gRPC Service exists but server not listening: mitigate by having chart manage the env var.
- Server listens but no Service/port: mitigate by coupling the env var to `grpc.enabled`.

## Acceptance Criteria
- `grpc.enabled` reliably predicts whether gRPC is reachable.
- GitOps values do not need to set `JANGAR_GRPC_ENABLED` manually for the control plane.

## References
- Kubernetes Services: https://kubernetes.io/docs/concepts/services-networking/service/

