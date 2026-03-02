# Chart gRPC Enabled: Single Source of Truth

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Overview

The chart now treats gRPC for the control plane as chart-driven and deterministic:

- `grpc.enabled` controls control-plane gRPC service exposure and listener configuration.
- When `grpc.manageEnvVar=true` (default), the chart owns these control-plane environment variables:
  - `JANGAR_GRPC_ENABLED`
  - `JANGAR_GRPC_HOST`
  - `JANGAR_GRPC_PORT`
- Controllers retain chart-managed defaults in `charts/agents/templates/deployment-controllers.yaml` unless
  they are explicitly overridden in `controllers.env.vars`.

## Scope

- Control-plane deployment: `charts/agents/templates/deployment.yaml`
- Controllers deployment: `charts/agents/templates/deployment-controllers.yaml`
- gRPC service: `charts/agents/templates/service-grpc.yaml`

## Contract

- `grpc.enabled` is the source-of-truth for whether control-plane gRPC is enabled.
- `grpc.manageEnvVar` (default `true`) controls whether the chart injects control-plane values for
  `JANGAR_GRPC_ENABLED`, `JANGAR_GRPC_HOST`, and `JANGAR_GRPC_PORT`.
- `JANGAR_GRPC_*` in `env.vars` / `controlPlane.env.vars` is treated as a conflicting override when
  `grpc.manageEnvVar=true`; values must match managed defaults or rendering fails.
- `grpc.manageEnvVar=false` restores manual env-var ownership for control-plane gRPC keys.
- Controllers are owned by `controllers.env.vars` for chart-managed `JANGAR_GRPC_*` guards: if you set
  controller-side gRPC env vars there, those values become authoritative for controller behavior.
- When managed mode is enabled, `env.vars`, `controlPlane.env.vars`, and any explicit `controllers.env.vars` for managed keys
  must align. If they disagree, validation fails.

## Migration guidance

1. Set:

   ```yaml
   grpc:
     enabled: true
     manageEnvVar: true
   ```

2. Remove manual control-plane gRPC values once migrated:

   - `env.vars.JANGAR_GRPC_ENABLED`
   - `env.vars.JANGAR_GRPC_HOST` (if present)
   - `env.vars.JANGAR_GRPC_PORT` (if present)
   - `controlPlane.env.vars.JANGAR_GRPC_ENABLED`
   - `controlPlane.env.vars.JANGAR_GRPC_HOST` (if present)
   - `controlPlane.env.vars.JANGAR_GRPC_PORT` (if present)

3. For controller-side gRPC migration:

   - Keep `controllers.env.vars.JANGAR_GRPC_ENABLED` explicit only when non-zero behavior is intentional.
   - Leave it unset for the default chart-managed `JANGAR_GRPC_ENABLED=0`.

4. For control-plane exceptions, set `grpc.manageEnvVar: false` and continue managing
   control-plane gRPC keys explicitly.

## Runtime mapping

| Values                               | Rendered object(s)                                                   | Effect |
| ------------------------------------ | -------------------------------------------------------------------- | ------ |
| `grpc.enabled=true`, `manageEnvVar=true` | `Service/agents-grpc`, `containerPort: grpc`, `JANGAR_GRPC_ENABLED=true` | Server exposes and listens on gRPC port. |
| `grpc.enabled=false`, `manageEnvVar=true` | no gRPC service/port, `JANGAR_GRPC_ENABLED=false`                   | Server does not expose/listen. |
| `manageEnvVar=false` | no chart-managed control-plane `JANGAR_GRPC_*` env vars are injected | Explicit control-plane env-var management must be complete. |

## Validation

- Helm validation fails when `grpc.manageEnvVar=true` and explicit control-plane `JANGAR_GRPC_*` values
  disagree with managed values, including mismatched values across `env.vars` and `controlPlane.env.vars`.

```bash
helm template charts/agents \
  --set grpc.enabled=true \
  --set grpc.manageEnvVar=true \
  --set controlPlane.env.vars.JANGAR_GRPC_ENABLED=true
```

Controller-side validation example:

```bash
helm template charts/agents \
  --set controllers.env.vars.JANGAR_GRPC_ENABLED=true \
  --set controllers.env.vars.JANGAR_GRPC_HOST=127.0.0.1
```

## Related checklist

- `docs/agents/designs/chart-env-vars-merge-precedence.md`
- `docs/agents/designs/chart-envfrom-conflict-resolution.md`

## Failure modes and mitigations

- Service and env-var drift: managed mode ensures `grpc.enabled` and control-plane gRPC env vars remain aligned.
- Contradictory overrides: validation fails in chart render, preventing silent drift.
