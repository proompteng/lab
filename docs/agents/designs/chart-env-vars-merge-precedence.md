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
3. `grpc.manageEnvVar=true` injects managed gRPC values from `grpc.*` and rejects mismatched explicit overrides in validation while preserving deterministic controller defaults.
4. Runtime defaults apply after render.

For controllers:

1. `controllers.env.vars` wins over `env.vars`.
2. `env.vars` is second.
3. Chart-managed controller defaults are then applied only when the merged map does not set the key:
   - `JANGAR_MIGRATIONS=skip`
   - `JANGAR_GRPC_ENABLED=0`
   - `JANGAR_GRPC_HOST=0.0.0.0`
   - `JANGAR_GRPC_PORT=<grpc.port>`
   - `JANGAR_CONTROL_PLANE_CACHE_ENABLED=0`
   - idempotency/artifact defaults when unset
4. `env.vars`, `controlPlane.env.vars`, and `controllers.env.vars` are validated in managed mode for managed `JANGAR_GRPC_*` keys.
5. Runtime defaults apply after render.

## Deterministic gRPC source-of-truth

- `grpc.manageEnvVar=true` (default) forces control-plane values:
  - `JANGAR_GRPC_ENABLED` from `grpc.enabled`
  - `JANGAR_GRPC_HOST` from chart default (`0.0.0.0`)
  - `JANGAR_GRPC_PORT` from `grpc.port`
- Contradictory explicit values in control-plane env maps fail validation.
- If both `env.vars` and a component map set managed gRPC values, they must match exactly.
- Set `grpc.manageEnvVar=false` to opt back into manual control-plane ownership for the three keys.
- Controllers keep `JANGAR_GRPC_ENABLED` managed by chart defaults unless overridden explicitly
  in `controllers.env.vars`.

  Controller default set is:
  - `JANGAR_GRPC_ENABLED=0`
  - `JANGAR_GRPC_HOST=0.0.0.0`
  - `JANGAR_GRPC_PORT=<grpc.port>`

## envFrom conflict behavior

- `env:` entries still take runtime precedence over `envFrom` imports.
- Structured `envFrom` entries can declare `keys` for reserved-key validation.
- `validation.reservedEnvKeysEnforced=true` (default) blocks rendering when a reserved key from `envFrom` does not follow component ownership rules:
  - control plane: `controlPlane.env.vars` or `env.vars`
  - controllers: `controllers.env.vars` or `env.vars` when `controllers.enabled=true`
- For managed `JANGAR_GRPC_*` keys, values must align when envFrom declares them.
  If you rely on chart-managed defaults, explicit component pinning is not required.
- `envFrom` cannot be used as an undocumented source for managed chart keys: if keys are declared and
  `grpc.manageEnvVar=true`, the pinned component values must align with chart-managed expectations.

## Notes

- Controllers retain safe defaults (`JANGAR_MIGRATIONS=skip`, `JANGAR_GRPC_ENABLED=0`, `JANGAR_CONTROL_PLANE_CACHE_ENABLED=0`) when they do not set explicit component values in either `env.vars` or `controllers.env.vars`.
- Use explicit chart values for security-sensitive toggles; avoid relying on runtime import order.
