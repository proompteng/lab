# Chart Env Var Merge Precedence

Status: Draft (2026-02-06)

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

### Source of truth
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen: `services/jangar/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Controllers:
  - Agents/AgentRuns: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml`, `argocd/applications/argo-workflows/*.yaml`

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`charts/agents/templates/deployment.yaml` via `.Values.controlPlane.image.*`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`charts/agents/templates/deployment-controllers.yaml` via `.Values.image.*` unless `.Values.controllers.image.*` is set): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Controllers enabled: `controllers.enabled: true` (separate `agents-controllers` deployment). See `argocd/applications/agents/values.yaml`.
- gRPC enabled: chart `grpc.enabled: true` and runtime `JANGAR_GRPC_ENABLED: "true"` in `.Values.env.vars`. See `argocd/applications/agents/values.yaml`.
- Database configured via SecretRef: `database.secretRef.name: jangar-db-app` and `database.secretRef.key: uri` (rendered as `DATABASE_URL`). See `argocd/applications/agents/values.yaml` and `charts/agents/templates/deployment.yaml`.

Note: Treat `charts/agents/**` and `argocd/applications/**` as the desired state. To verify live cluster state, run:

```bash
kubectl get application -n argocd agents
kubectl get application -n argocd froussard
kubectl get ns | rg '^(agents|agents-ci|jangar|froussard)\b'
kubectl get deploy -n agents
kubectl get crd | rg 'proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access):
  - `kubectl get pods -n agents`
  - `kubectl logs -n agents deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
