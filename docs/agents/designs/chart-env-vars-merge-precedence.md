# Chart Env Var Merge Precedence

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Scope

This contract covers values-to-container environment mapping for:

- `charts/agents/templates/deployment.yaml`
- `charts/agents/templates/deployment-controllers.yaml`
- `charts/agents/templates/validation.yaml`

## Precedence model

For the control plane:

1. `controlPlane.env.vars` wins over `env.vars`.
2. `env.vars` is second.
3. Chart-managed gRPC values from `grpc.*` are applied next when `grpc.manageEnvVar=true`.
4. Runtime defaults apply after render.

For controllers:

1. `controllers.env.vars` wins over `env.vars`.
2. `env.vars` is second.
3. Chart-managed controller defaults are then applied and may override `env.vars` for certain reserved keys:
   - `JANGAR_MIGRATIONS=skip`
   - `JANGAR_GRPC_ENABLED=0`
   - `JANGAR_CONTROL_PLANE_CACHE_ENABLED=0`
   - idempotency/artifact defaults when unset
4. Runtime defaults apply after render.

## Deterministic gRPC source-of-truth

- `grpc.manageEnvVar=true` (default) forces control-plane values:
  - `JANGAR_GRPC_ENABLED` from `grpc.enabled`
  - `JANGAR_GRPC_HOST` from chart default (`0.0.0.0`)
  - `JANGAR_GRPC_PORT` from `grpc.port`
- Contradictory explicit values in control-plane env maps fail validation.
- Set `grpc.manageEnvVar=false` to opt back into manual control-plane ownership for the three keys.
- Controllers keep `JANGAR_GRPC_ENABLED` managed by chart defaults unless overridden explicitly
  in `controllers.env.vars`.

## envFrom conflict behavior

- `env:` still takes precedence at runtime over `envFrom`.
- Structured `envFrom` entries can declare `keys` for reserved-key validation.
- `validation.reservedEnvKeysEnforced=true` blocks rendering when a reserved key from `envFrom` is not explicitly
  pinned in the component map used by the consuming deployment:
  - control plane: `controlPlane.env.vars` or `env.vars`
  - controllers: `controllers.env.vars`

## Notes

- Controllers retain safe defaults (`JANGAR_MIGRATIONS=skip`, `JANGAR_GRPC_ENABLED=0`) when they do not set explicit component values.
- Use explicit chart values for security-sensitive toggles; avoid relying on runtime import order.
