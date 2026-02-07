# Chart Controller Namespaces: Empty Semantics

Status: Draft (2026-02-07)

## Overview
Controllers reconcile CRDs in a set of namespaces. The chart exposes `controller.namespaces`, but it is not documented what an empty list means (disabled? all namespaces? release namespace only?). Ambiguity here creates production risk.

## Goals
- Define an explicit meaning for `controller.namespaces: []`.
- Prevent accidental cluster-wide reconciliation in namespaced installs.
- Make namespace scope observable and testable.

## Non-Goals
- Redesigning multi-namespace support (covered separately).

## Current State
- Values: `charts/agents/values.yaml` exposes `controller.namespaces: []`.
- Template renders namespaces into env vars:
  - `JANGAR_AGENTS_CONTROLLER_NAMESPACES`: `charts/agents/templates/deployment-controllers.yaml`
  - helper: `charts/agents/templates/_helpers.tpl` (`agents.controllerNamespaces`)
- Runtime parsing:
  - `services/jangar/src/server/implementation-source-webhooks.ts` reads `process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES`.
  - Controllers use namespace scoping utilities in `services/jangar/src/server/namespace-scope.ts`.
- Cluster desired state sets `controller.namespaces: [agents]` in `argocd/applications/agents/values.yaml`.

## Design
### Semantics
- `controller.namespaces` MUST be required when `rbac.clusterScoped=false`.
- Empty list MUST mean “no namespaces configured” and controllers SHOULD refuse to start (fail-fast) to avoid a false sense of safety.
- For `rbac.clusterScoped=true`, introduce an explicit value:
  - `controller.namespaces: [\"*\"]` to mean “all namespaces”, rather than interpreting empty as all.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.namespaces: [\"agents\"]` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[\"agents\"]` | Reconcile only `agents` namespace resources. |
| `controller.namespaces: []` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[]` (or unset) | Fail-fast at startup unless clusterScoped=true and explicit wildcard used. |
| `controller.namespaces: [\"*\"]` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[\"*\"]` | (When clusterScoped=true) reconcile all namespaces. |

## Rollout Plan
1. Document semantics and recommend non-empty namespaces for prod.
2. Add controller startup validation in `services/jangar/src/server/*`:
   - If env var is empty/unset: exit with clear error.
3. Add chart schema rule: when `controller.enabled=true`, require at least one namespace unless clusterScoped=true and wildcard is used.

Rollback:
- Disable fail-fast validation (code rollback).

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"JANGAR_AGENTS_CONTROLLER_NAMESPACES\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"NAMESPACES|namespace\"
```

## Failure Modes and Mitigations
- Empty list interpreted as “all namespaces” unexpectedly: mitigate by banning that interpretation.
- Controllers start but do nothing due to empty scope: mitigate with fail-fast.
- Wildcard scope used with namespaced RBAC: mitigate by schema validation and startup checks.

## Acceptance Criteria
- Empty namespaces configuration is rejected with a clear, actionable error.
- Wildcard all-namespaces requires explicit `\"*\"` and cluster-scoped RBAC.

## References
- Kubernetes controller patterns (namespace scoping best practices): https://kubernetes.io/docs/concepts/architecture/controller/
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

