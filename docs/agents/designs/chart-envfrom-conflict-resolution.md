# Chart envFrom Conflict Resolution

Status: Current (2026-03-01)

Docs index: [README](../README.md)

## Overview

The chart supports both explicit `env:` entries and Kubernetes `envFrom` imports.
`env:` still wins for duplicate keys at runtime. To make that explicit and safer,
the chart now supports guarded `envFrom` declarations with optional key hints and
optional validation in chart rendering.

## Contract

- `envFrom` is best used for non-application credentials and feature flags
  that do not collide with chart-managed keys.
- Reserved keys are defined by chart behavior and validated when
  `validation.reservedEnvKeysEnforced=true`.
- If a reserved key is listed in a structured `envFrom` reference, it must also be
  explicitly set in the env map for the component that consumes `envFrom`:
  - control plane: `controlPlane.env.vars` or global `env.vars`
  - controllers: `controllers.env.vars` only
- `envFrom` can still be a string (legacy mode): `["existing-secret"]`.
- New structured mode enables safer metadata:

  ```yaml
  envFromSecretRefs:
    - name: agents-github-token-env
      optional: false
      keys:
        - JANGAR_GITHUB_TOKEN
  ```

  The `keys` field is used only for validation and does not change runtime behavior.

## Validation

- Gate key:

```yaml
validation:
  reservedEnvKeysEnforced: true
```

- If set and a structured `envFrom` entry declares a reserved key, chart render fails
  unless the key is explicitly overridden by the matching component map.
- If `JANGAR_GRPC_*` is declared in structured `envFrom`, controlled-mode rendering also requires
  the pinned component values to match chart-managed gRPC defaults when `grpc.manageEnvVar=true`.

## Migration guidance

1. Leave existing plain string `envFrom` arrays in place (fully backward compatible).
2. For reserved key protection, migrate to structured entries and include `keys` for keys that matter.
3. If validation blocks render, either:
   - add the key to the relevant component env map, or
   - disable enforcement by setting `validation.reservedEnvKeysEnforced=false`.
   - keep `env.vars` and `controlPlane.env.vars` aligned for shared managed gRPC keys when both are used.

## Reserved key set used by this chart

- `JANGAR_GRPC_ENABLED`, `JANGAR_GRPC_HOST`, `JANGAR_GRPC_PORT`
- `JANGAR_MIGRATIONS`
- `JANGAR_CONTROL_PLANE_CACHE_ENABLED`
- `JANGAR_AGENTRUN_IDEMPOTENCY_ENABLED`
- `JANGAR_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS`
- `JANGAR_AGENTRUN_ARTIFACTS_MAX`
- `JANGAR_AGENTRUN_ARTIFACTS_STRICT`

## Failure modes and mitigations

- Reserved key declared in `envFrom` without explicit override: rendering fails in validation mode.
- Secret/config drift via broad key imports: represent imports with explicit key lists and keep
  chart-managed values explicit.
