# Chart Controller Namespaces: Empty Semantics

Status: Draft (2026-02-07)

Docs index: [README](../README.md)

## Overview

Controllers reconcile CRDs in a set of namespaces. The chart exposes `controller.namespaces`; an explicit empty list is now treated as invalid configuration.

## Goals

- Define an explicit meaning for `controller.namespaces` when explicitly set.
- Prevent accidental cluster-wide reconciliation in namespaced installs.
- Make namespace scope observable and testable.

## Non-Goals

- Redesigning multi-namespace support (covered separately).

## Current State

- Values: `charts/agents/values.yaml` no longer sets `controller.namespaces` explicitly.
- Template renders namespaces into env vars:
  - `AGENTS_CONTROLLER_NAMESPACES`: `charts/agents/templates/deployment-controllers.yaml`
  - helper: `charts/agents/templates/_helpers.tpl` (`agents.controllerNamespaces`)
- Runtime parsing:
  - `services/agents/src/server/implementation-source-webhooks.ts` reads Agents controller namespace configuration.
  - Controllers use namespace scoping utilities in `services/jangar/src/server/namespace-scope.ts`.
- Cluster desired state sets `controller.namespaces: [agents]` in `argocd/applications/agents/values.yaml`.

## Design

### Semantics

- `controller.namespaces` is optional. When omitted, templates default to the release namespace.
- When set, `controller.namespaces` must be a non-empty list.
- Empty list (`[]`) is rejected at Helm render-time.
- In namespaced mode (`rbac.clusterScoped=false`), an explicit single namespace must match
  the chart namespace (`namespaceOverride`/`Release.Namespace`) to avoid forbidden-list failures.
- For `rbac.clusterScoped=true`, explicit `controller.namespaces: ["*"]` means all namespaces.

## Config Mapping

| Helm value                            | Env var                                                          | Intended behavior                                   |
| ------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `controller.namespaces: [\"agents\"]` | `AGENTS_CONTROLLER_NAMESPACES=[\"agents\"]`                      | Reconcile only `agents` namespace resources.        |
| omitted                               | `AGENTS_CONTROLLER_NAMESPACES=[\"agents\"]` (templated fallback) | Reconcile the release namespace resources.          |
| `controller.namespaces: [\"*\"]`      | `AGENTS_CONTROLLER_NAMESPACES=[\"*\"]`                           | (When clusterScoped=true) reconcile all namespaces. |

## Rollout Plan

1. Document semantics and recommend non-empty namespaces for prod.
2. Add controller startup validation in `services/agents/src/server/*`:
   - If env var is empty/unset: exit with clear error.
3. Add chart schema and render-time validation: when `controller.namespaces` is explicitly set, require a non-empty, valid list and reject empty arrays.

Rollback:

- Disable fail-fast validation (code rollback).

## Validation

```bash
mise exec helm@3 -- helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"AGENTS_CONTROLLER_NAMESPACES\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"NAMESPACES|namespace\"
```

## Failure Modes and Mitigations

- Empty list interpreted as all namespaces: blocked at render-time by explicit validation.
- Controllers start with empty scope: blocked at render-time before startup.
- Wildcard scope used with namespaced RBAC: blocked by schema and render-time validation.

## Acceptance Criteria

- Empty namespaces configuration is rejected with a clear, actionable error.
- Wildcard all-namespaces requires explicit `\"*\"` and cluster-scoped RBAC.

## References

- Kubernetes controller patterns (namespace scoping best practices): https://kubernetes.io/docs/concepts/architecture/controller/
