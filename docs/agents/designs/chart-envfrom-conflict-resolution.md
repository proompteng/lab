# Chart envFrom Conflict Resolution

Status: Current (2026-03-02)

Docs index: [README](../README.md)

## Overview

The chart supports both explicit `env:` entries and Kubernetes `envFrom` imports.
`env:` still wins for duplicate keys at runtime. To make configuration safe and
predictable, chart rendering can validate structured `envFrom` keys against
reserved key ownership and chart-managed defaults.

## Contract

- `envFrom` is best used for non-application credentials and feature flags that do
  not collide with reserved/managed keys.
- Reserved keys are defined by chart behavior and validated when
  `validation.reservedEnvKeysEnforced=true` (default).
- If a reserved key is listed in a structured `envFrom` reference, it must also be
  explicitly set in the env map for the component that consumes `envFrom`:
  - control plane: `controlPlane.env.vars` or global `env.vars`
  - controllers: `controllers.env.vars` or global `env.vars` (and only when `controllers.enabled=true`)
- `envFrom` can still be a string (legacy mode): `['existing-secret']`.
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
  unless the key is explicitly set in the consuming component map(s).
- If `JANGAR_GRPC_*` is declared in structured `envFrom`, chart render enforces
  deterministic values when `grpc.manageEnvVar=true`:
  - control plane: `JANGAR_GRPC_ENABLED={{ .Values.grpc.enabled }}`, `JANGAR_GRPC_HOST=0.0.0.0`, `JANGAR_GRPC_PORT={{ .Values.grpc.port }}`
  - controllers: when `grpc.enabled=true`, `JANGAR_GRPC_ENABLED=0`, `JANGAR_GRPC_HOST=0.0.0.0`, `JANGAR_GRPC_PORT={{ .Values.grpc.port }}`
- If both control-plane and controller component maps define managed `JANGAR_GRPC_*` and their values disagree, envFrom validation fails to prevent cross-component drift.
- If managed `JANGAR_GRPC_*` values are intentionally diverged, set
  `grpc.manageEnvVar=false` and control the values explicitly in each component.

## Migration guidance

1. Leave existing plain string `envFrom` arrays in place (fully backward compatible).
2. For reserved key protection, migrate to structured entries and include `keys` for keys that matter.
3. If validation blocks render, either:
   - add the key to the relevant component env map, or
   - disable enforcement by setting `validation.reservedEnvKeysEnforced=false`.
4. Keep `env.vars`, `controlPlane.env.vars`, and `controllers.env.vars` aligned for managed `JANGAR_GRPC_*` when both are used.

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
