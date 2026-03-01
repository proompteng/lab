# Chart gRPC Enabled: Single Source of Truth

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Overview

The chart now treats gRPC behavior for the control plane as chart-driven and deterministic:

- `grpc.enabled` controls both service exposure and container listener configuration.
- When `grpc.manageEnvVar=true` (default), the chart owns and writes:
  - `JANGAR_GRPC_ENABLED`
  - `JANGAR_GRPC_HOST`
  - `JANGAR_GRPC_PORT`

## Scope

- Control-plane deployment: `charts/agents/templates/deployment.yaml`
- Controllers deployment: `charts/agents/templates/deployment-controllers.yaml`
- gRPC service: `charts/agents/templates/service-grpc.yaml`

## Contract

- `grpc.enabled` is the source-of-truth for whether control-plane gRPC is enabled.
- `grpc.manageEnvVar` (default `true`) controls whether chart-generated env vars for
  `JANGAR_GRPC_ENABLED`, `JANGAR_GRPC_HOST`, and `JANGAR_GRPC_PORT` are written.
- `JANGAR_GRPC_ENABLED` in `env.vars` / `controlPlane.env.vars` is not interpreted as an override
  when `grpc.manageEnvVar=true`; it must match the managed value or rendering fails.
- `grpc.manageEnvVar=false` restores manual env-var ownership for the three keys above.

## Migration guidance

1. Set:

   ```yaml
   grpc:
     enabled: true
     manageEnvVar: true
   ```

2. Remove manual gRPC keys from values overrides once migrated:

   - `env.vars.JANGAR_GRPC_ENABLED`
   - `env.vars.JANGAR_GRPC_HOST` (if present)
   - `env.vars.JANGAR_GRPC_PORT` (if present)

3. For exceptions, set `grpc.manageEnvVar: false` and continue managing these keys explicitly.

## Runtime mapping

| Values                               | Rendered object(s)                                                       | Effect |
| ------------------------------------ | ------------------------------------------------------------------------ | ------ |
| `grpc.enabled=true`, `manageEnvVar=true` | `Service/agents-grpc`, `containerPort: grpc`, `JANGAR_GRPC_ENABLED=true`   | Server exposes and listens on gRPC port. |
| `grpc.enabled=false`, `manageEnvVar=true` | no gRPC service/port, `JANGAR_GRPC_ENABLED=false`                       | Server does not expose/listen. |
| `manageEnvVar=false` | no chart-managed `JANGAR_GRPC_*` env vars are injected | Explicit env-var management must be complete. |

## Validation

- Helm validation fails when `grpc.manageEnvVar=true` and explicit `JANGAR_GRPC_*` env-vars disagree
  with the managed values.

```bash
helm template charts/agents \
  --set grpc.enabled=true \
  --set grpc.manageEnvVar=true \
  --set controlPlane.env.vars.JANGAR_GRPC_ENABLED=true
```

## Related checklist

- `docs/agents/designs/chart-env-vars-merge-precedence.md`
- `docs/agents/designs/chart-envfrom-conflict-resolution.md`

## Failure modes and mitigations

- Service and env-var drift: managed mode ensures `grpc.enabled`, port, and gRPC env-vars remain aligned.
- Contradictory overrides: validation fails in chart render, preventing silent drift.
