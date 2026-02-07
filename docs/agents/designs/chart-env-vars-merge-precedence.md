# Chart Env Var Merge Precedence

Status: Draft (2026-02-07)

## Overview
The Agents Helm chart exposes multiple ways to set environment variables for the control plane and controllers. Today the precedence is implicit in templates, which makes it easy to unintentionally override critical defaults (e.g. migrations, gRPC enablement) or to believe a value is set when it is not.

This doc defines a production-safe, testable precedence order and the validation behavior the chart/controllers should implement.

## Goals
- Make env var precedence explicit and deterministic.
- Prevent accidental overrides of chart-managed safety defaults.
- Provide a single table operators can use to predict runtime behavior.

## Non-Goals
- Replacing env vars with a fully typed config file system.
- Adding new runtime features beyond precedence/validation.

## Current State
- Chart templates:
  - Control plane env merge: `charts/agents/templates/deployment.yaml` (merges `.Values.env.vars` with `.Values.controlPlane.env.vars`).
  - Controllers env merge + forced defaults: `charts/agents/templates/deployment-controllers.yaml` (merges `.Values.env.vars` with `.Values.controllers.env.vars`, then sets defaults for `JANGAR_MIGRATIONS`, `JANGAR_GRPC_ENABLED`, `JANGAR_CONTROL_PLANE_CACHE_ENABLED` when not explicitly provided).
- Values surface area: `charts/agents/values.yaml` (`env.vars`, `env.extra`, `env.secrets`, `env.config`, `controlPlane.env.vars`, `controllers.env.vars`).
- Controllers runtime reads many `process.env.JANGAR_*` variables: `services/jangar/src/server/agents-controller.ts` and `services/jangar/src/server/implementation-source-webhooks.ts`.
- Cluster desired state (GitOps):
  - `argocd/applications/agents/values.yaml` sets some env vars directly under `.env.vars` and control plane vars under `.controlPlane.env.vars`.

## Design
### Precedence order (highest wins)
1. `.Values.controllers.env.vars` / `.Values.controlPlane.env.vars` (component-local explicit overrides)
2. `.Values.env.vars` (global explicit overrides)
3. Chart-implied defaults (template-set env vars like `JANGAR_MIGRATIONS=skip` for controllers)
4. Application defaults (code defaults when env var is absent)

### Conflict handling
- If the same key is set in both `.Values.env.vars` and a component-local `*.env.vars`, the component-local value MUST win.
- If the same key is set both via explicit `env:` entries (e.g. `.Values.env.extra`) and via `envFrom` (Secret/ConfigMap), behavior is Kubernetes-defined and can be surprising. The chart SHOULD:
  - Prefer explicit `env:` for chart-managed defaults.
  - Document that `envFrom` is “best effort” and may be overridden by explicit `env:`.

### Controller-side validation (recommended)
Add a lightweight startup check (controllers only) that:
- Logs the effective source for critical vars (`JANGAR_MIGRATIONS`, `JANGAR_GRPC_ENABLED`) at startup.
- Refuses to start if `JANGAR_MIGRATIONS=auto` is set in the controllers deployment (to prevent surprise migrations from the controller pod).

## Config Mapping
| Helm value | Rendered env var | Default today | Intended behavior |
|---|---|---:|---|
| `env.vars.JANGAR_MIGRATIONS` | `JANGAR_MIGRATIONS` | `auto` | Control plane may run migrations; controllers should default to `skip`. |
| `controllers.env.vars.JANGAR_MIGRATIONS` | `JANGAR_MIGRATIONS` | `skip` (template default) | If explicitly set, overrides template default; controllers MUST validate. |
| `env.vars.JANGAR_GRPC_ENABLED` | `JANGAR_GRPC_ENABLED` | unset | Global opt-in/out for control plane; controllers should default to `0`. |
| `controllers.env.vars.JANGAR_GRPC_ENABLED` | `JANGAR_GRPC_ENABLED` | `0` (template default) | Controllers may force-disable gRPC unless explicitly enabled. |
| `controlPlane.env.vars.JANGAR_CONTROL_PLANE_CACHE_ENABLED` | `JANGAR_CONTROL_PLANE_CACHE_ENABLED` | unset | Control plane feature toggle; controllers default to `0` unless explicitly set. |

## Rollout Plan
1. Document precedence in `charts/agents/README.md` and values comments (no behavior change).
2. Add startup logging/validation in `services/jangar/src/server/*` (controllers only) with a conservative default (warn-only first).
3. Promote validation to fail-fast in a follow-up after a canary window.

Rollback:
- Revert controller-side validation (code-only rollback).
- Keep doc updates; they are safe.

## Validation
Helm render:
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"JANGAR_MIGRATIONS|JANGAR_GRPC_ENABLED\"
```

Cluster (desired/live):
```bash
kubectl -n agents get deploy agents -o yaml | rg -n \"JANGAR_MIGRATIONS|JANGAR_GRPC_ENABLED\"
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"JANGAR_MIGRATIONS|JANGAR_GRPC_ENABLED\"
```

## Failure Modes and Mitigations
- Env var appears “set” but is overridden by component-local vars: mitigate with explicit precedence docs and startup logging.
- Controllers unexpectedly run migrations: mitigate by template default (`skip`) + controller fail-fast validation.
- gRPC accidentally enabled in controllers: mitigate with explicit defaults and chart-level tests (golden manifest render).

## Acceptance Criteria
- Operators can predict the effective value of a given env var from Helm values alone.
- Controllers deployment renders with `JANGAR_MIGRATIONS=skip` unless explicitly overridden.
- A canary install surfaces any unexpected overrides via logs before enforcing fail-fast.

## References
- Kubernetes environment variable precedence (explicit `env` vs `envFrom`): https://kubernetes.io/docs/tasks/inject-data-application/define-environment-variable-container/
- Helm chart best practices (values and templates): https://helm.sh/docs/chart_best_practices/values/
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Helm chart: `charts/agents/`
- Primary templates: `charts/agents/templates/` (see the doc’s **Current State** section for the exact files)
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

