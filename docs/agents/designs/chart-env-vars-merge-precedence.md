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

### Source of truth (repo)
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Runner RBAC for CI (desired state): `argocd/applications/agents-ci/`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen:
  - Go types: `services/jangar/api/agents/v1alpha1/types.go`
  - Validation + drift checks: `scripts/agents/validate-agents.sh`
- Controllers (primary code pointers):
  - Agents/AgentRuns reconcile loop: `services/jangar/src/server/agents-controller.ts`
  - Supporting primitives (budgets/approval/tools/etc): `services/jangar/src/server/supporting-primitives-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Policy logic (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
  - kubectl integration: `services/jangar/src/server/primitives-kube.ts`, `services/jangar/src/server/kube-watch.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml` (notably WorkflowTemplates in namespace `jangar`)

### Desired cluster state (GitOps)
As of 2026-02-07 (repo `main`):
- Namespace: `agents` (`argocd/applications/agents/kustomization.yaml`)
- Argo CD app: `agents` (`argocd/applications/agents/application.yaml`) with automated sync + Server Side Apply
- Helm release: `agents` installs chart `charts/agents` version `0.9.1` with `includeCRDs: true` (`argocd/applications/agents/kustomization.yaml`)
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`deploy/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`deploy/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation + RBAC:
  - `controller.namespaces: [agents]`
  - `rbac.clusterScoped: false`
- Database wiring:
  - `database.secretRef.name: jangar-db-app`
  - `database.secretRef.key: uri`
- gRPC (control plane service):
  - `grpc.enabled: true`
  - `grpc.serviceType: ClusterIP`
  - `grpc.port/servicePort: 50051`
- Bootstrap CRs/resources applied alongside the Helm release (if the Argo app is Synced):
  - `SecretBinding/codex-github-token`: `argocd/applications/agents/codex-secretbinding.yaml`
  - `AgentProvider/codex-runner`: `argocd/applications/agents/codex-agentprovider.yaml`
  - `Agent/codex`: `argocd/applications/agents/codex-agent.yaml`
  - `VersionControlProvider/github`: `argocd/applications/agents/codex-versioncontrolprovider.yaml`
  - `ConfigMap/codex-agent-system-prompt`: `argocd/applications/agents/codex-agent-system-prompt-configmap.yaml`
  - Sample policies: `argocd/applications/agents/sample-approvalpolicy.yaml`, `argocd/applications/agents/sample-budget.yaml`, `argocd/applications/agents/sample-signal.yaml`

### Live cluster verification (requires RBAC)
Treat `charts/agents/**` and `argocd/applications/**` as desired state. To confirm the *live* cluster is synced (and catch drift), run from an operator machine/service-account that can read Argo CD + the `agents` namespace:

```bash
# Argo CD sync/health
kubectl get application -n argocd agents -o wide
kubectl get application -n argocd agents -o yaml | rg -n "sync|health|targetRevision|revision"

# Control plane + controllers workload
kubectl -n agents get deploy,rs,pods,svc -o wide
kubectl -n agents rollout status deploy/agents
kubectl -n agents rollout status deploy/agents-controllers
kubectl -n agents logs deploy/agents --tail=200
kubectl -n agents logs deploy/agents-controllers --tail=200

# CRDs + bootstrap CRs
kubectl -n agents get agentproviders.agents.proompteng.ai,agents.agents.proompteng.ai,versioncontrolproviders.agents.proompteng.ai
kubectl -n agents get approvalpolicies.approvals.proompteng.ai,budgets.budgets.proompteng.ai,signals.signals.proompteng.ai

# Optional (cluster-scope): confirm CRDs installed
kubectl get crd | rg 'proompteng\.ai'
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

Precedence rules to remember when debugging:
- `env.vars` is the shared base env map.
- `controlPlane.env.vars` overlays `env.vars` for `deploy/agents`.
- `controllers.env.vars` overlays `env.vars` for `deploy/agents-controllers`.
- Some controller-side env vars are forced unless explicitly overridden (e.g. `JANGAR_MIGRATIONS=skip` and `JANGAR_GRPC_ENABLED=0`).

Common mappings:
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` and `JANGAR_PRIMITIVES_NAMESPACES`
- `controller.concurrency.*` → `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE`, `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_AGENT`, `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER`
- `controller.queue.*` → `JANGAR_AGENTS_CONTROLLER_QUEUE_NAMESPACE`, `JANGAR_AGENTS_CONTROLLER_QUEUE_REPO`, `JANGAR_AGENTS_CONTROLLER_QUEUE_CLUSTER`
- `controller.rate.*` → `JANGAR_AGENTS_CONTROLLER_RATE_WINDOW_SECONDS`, `JANGAR_AGENTS_CONTROLLER_RATE_NAMESPACE`, `JANGAR_AGENTS_CONTROLLER_RATE_REPO`, `JANGAR_AGENTS_CONTROLLER_RATE_CLUSTER`
- `controller.agentRunRetentionSeconds` → `JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS`
- `controller.admissionPolicy.*` → `JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED|ALLOWED|DENIED`, `JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED|DENIED`, `JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS`
- `controller.vcsProviders.*` → `JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED` (+ related VCS policy env vars)
- `controller.authSecret.*` → `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME|KEY|MOUNT_PATH`
- `orchestrationController.*` → `JANGAR_ORCHESTRATION_CONTROLLER_ENABLED|NAMESPACES`
- `supportingController.*` → `JANGAR_SUPPORTING_CONTROLLER_ENABLED|NAMESPACES`
- `grpc.*` → `JANGAR_GRPC_ENABLED|HOST|PORT` (unless overridden via `env.vars`)
- `controller.jobTtlSecondsAfterFinished` → `JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS`
- `runtime.*` → `JANGAR_AGENT_RUNNER_IMAGE`, `JANGAR_AGENT_IMAGE`, `JANGAR_SCHEDULE_RUNNER_IMAGE`, `JANGAR_SCHEDULE_SERVICE_ACCOUNT` (unless overridden via `env.vars`)

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally (fast, deterministic):
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
   - Render the full install: `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
3. Update GitOps values when behavior/config changes require it:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

Rollback (GitOps):
- Revert the PR (or pin the chart/image back) and let Argo CD self-heal.

### Validation (smoke)
- Schema + examples (local): `scripts/agents/validate-agents.sh`
- Render (local): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- In-cluster (operator RBAC required):
  - `kubectl -n agents get pods`
  - `kubectl -n agents logs deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
