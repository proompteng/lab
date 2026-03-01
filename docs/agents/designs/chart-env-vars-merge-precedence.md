# Chart Env Var Merge Precedence

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Scope

This contract covers values-to-container environment mapping for:

- `charts/agents/templates/deployment.yaml`
- `charts/agents/templates/deployment-controllers.yaml`
- `charts/agents/templates/validation.yaml`

## Precedence model

1. Component-local explicit vars win:
   - `controlPlane.env.vars` for control plane
   - `controllers.env.vars` for controllers
2. Global explicit vars: `env.vars`
3. Chart-managed defaults in templates (including gRPC and controller safety defaults)
4. Runtime defaults in application code when keys are absent

## Deterministic gRPC source-of-truth

- `grpc.manageEnvVar=true` (default) forces:
  - control-plane `JANGAR_GRPC_ENABLED` from `grpc.enabled`
  - `JANGAR_GRPC_HOST` from chart default
  - `JANGAR_GRPC_PORT` from `grpc.port`
- Contradictory manual values in `env.vars`/`controlPlane.env.vars` fail validation.
- Set `grpc.manageEnvVar=false` to opt back into manual ownership for those keys.

## envFrom conflict behavior

- `env:` still takes precedence at runtime over `envFrom`.
- Structured `envFrom` entries can declare `keys` for reserved-key validation.
- `validation.reservedEnvKeysEnforced=true` blocks rendering when a reserved key from
  `envFrom` is not explicitly set in the component env map.

## Notes

- Controllers retain safe defaults (`JANGAR_MIGRATIONS=skip`, `JANGAR_GRPC_ENABLED=0`) when they do not set explicit component values.
- Use explicit chart values for security-sensitive toggles; avoid relying on runtime import order.
