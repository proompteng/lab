# Controllers Deployment: gRPC Disabled by Default

Status: Draft (2026-02-07)
## Overview
The chart renders a separate controllers deployment that forces `JANGAR_GRPC_ENABLED=0` unless explicitly overridden. This is a good safety default (controllers do not need to expose gRPC externally), but it is undocumented and can be surprising when operators expect agentctl gRPC to be available everywhere.

This doc defines the intended behavior and introduces a controlled enablement path if needed.

## Goals
- Document why gRPC is disabled in controllers.
- Provide a safe opt-in for controller gRPC only when required.

## Non-Goals
- Making controllers gRPC publicly accessible.

## Current State
- Chart forces defaults in `charts/agents/templates/deployment-controllers.yaml`:
  - Sets `JANGAR_GRPC_ENABLED` to `"0"` unless present in `controllers.env.vars`.
- Control plane gRPC behavior is implemented in:
  - `services/jangar/src/server/control-plane-grpc.ts`
  - `services/jangar/src/server/agentctl-grpc.ts`
- Cluster desired state sets gRPC enabled for control plane in `argocd/applications/agents/values.yaml`.

## Design
### Contract
- Controllers gRPC remains disabled by default.
- If controller gRPC is needed (e.g., for internal debugging), enable it explicitly with:
  - `controllers.env.vars.JANGAR_GRPC_ENABLED: "true"`
and require `controllers.service.enabled=true` (see chart design) to avoid “listening but unreachable” states.

### Additional guardrails
- Add a startup log line in controllers indicating whether gRPC server started.
- Add chart validation: if `controllers.env.vars.JANGAR_GRPC_ENABLED=true`, require `controllers.service.enabled=true`.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_GRPC_ENABLED` | `JANGAR_GRPC_ENABLED` | Explicit opt-in for controllers gRPC server. |
| (unset) | `JANGAR_GRPC_ENABLED=0` | Default: controllers do not start gRPC server. |

## Rollout Plan
1. Document current forced default.
2. Add guardrails and optional Service support.
3. If needed, canary-enable controller gRPC in non-prod only.

Rollback:
- Remove the explicit env var and disable controller Service.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true | rg -n \"JANGAR_GRPC_ENABLED\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"gRPC|Agentctl\"
```

## Failure Modes and Mitigations
- Operators think gRPC is enabled due to `grpc.enabled=true`: mitigate by documenting that it affects only the control plane.
- gRPC enabled without Service: mitigate with render-time validation and an opt-in Service template.

## Acceptance Criteria
- It is clear (from values + render) whether controllers will run gRPC.
- Enabling controller gRPC requires explicit opt-in and is not accidental.

## References
- gRPC basics: https://grpc.io/docs/what-is-grpc/introduction/

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
