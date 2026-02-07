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
mise exec helm@3 -- helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"JANGAR_AGENTS_CONTROLLER_NAMESPACES\"
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

### Source of truth
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen: `services/jangar/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Control plane + controllers code:
  - Server entrypoints: `services/jangar/src/server/index.ts`, `services/jangar/src/server/app.ts`
  - Agents/AgentRuns controller: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml` (typically in namespace `jangar`)

### Current cluster state (GitOps desired + live API server)
As of 2026-02-07 (repo `main`):
- Kubernetes API server (live): `v1.35.0+k3s1` (from `kubectl get --raw /version`).
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`Deployment/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5436c9d2@sha256:b511d73a2622ea3a4f81f5507899bca1970a0e7b6a9742b42568362f1d682b9a`
  - Controllers (`Deployment/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5436c9d2@sha256:d673055eb54af663963dedfee69e63de46059254b830eca2a52e97e641f00349`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Database connectivity: `database.secretRef.name: jangar-db-app` / `key: uri`. See `argocd/applications/agents/values.yaml`.
- gRPC enabled: `grpc.enabled: true` on port `50051`. See `argocd/applications/agents/values.yaml`.
- Repo allowlist: `env.vars.JANGAR_GITHUB_REPOS_ALLOWED: proompteng/lab`. See `argocd/applications/agents/values.yaml`.
- Runner auth (GitHub token): `envFromSecretRefs: [agents-github-token-env]`. See `argocd/applications/agents/values.yaml`.

Note: This repo’s GitOps manifests are the desired state. Live verification requires a kubectl context/SA with list/get access in `agents` (and cluster-scoped access for CRDs).

To verify live cluster state (requires sufficient RBAC), run:

```bash
kubectl version --short
kubectl get --raw /version

kubectl -n agents auth can-i list deploy
kubectl -n agents get deploy
kubectl -n agents get pods

kubectl get application -n argocd agents
kubectl get crd | rg 'proompteng\.ai'

kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

Env var merge/precedence (see also `docs/agents/designs/chart-env-vars-merge-precedence.md`):
- Control plane: `.Values.env.vars` merged with `.Values.controlPlane.env.vars` (control-plane keys win).
- Controllers: `.Values.env.vars` merged with `.Values.controllers.env.vars` (controllers keys win), plus template defaults for `JANGAR_MIGRATIONS`, `JANGAR_GRPC_ENABLED`, and `JANGAR_CONTROL_PLANE_CACHE_ENABLED` when unset.

Common mappings:
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` (and also `JANGAR_PRIMITIVES_NAMESPACES`)
- `controller.concurrency.*` → `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_{NAMESPACE,AGENT,CLUSTER}`
- `controller.queue.*` → `JANGAR_AGENTS_CONTROLLER_QUEUE_{NAMESPACE,REPO,CLUSTER}`
- `controller.rate.*` → `JANGAR_AGENTS_CONTROLLER_RATE_{WINDOW_SECONDS,NAMESPACE,REPO,CLUSTER}`
- `controller.agentRunRetentionSeconds` → `JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS`
- `controller.admissionPolicy.*` → `JANGAR_AGENTS_CONTROLLER_{LABELS_REQUIRED,LABELS_ALLOWED,LABELS_DENIED,IMAGES_ALLOWED,IMAGES_DENIED,BLOCKED_SECRETS}`
- `controller.vcsProviders.*` → `JANGAR_AGENTS_CONTROLLER_VCS_{PROVIDERS_ENABLED,DEPRECATED_TOKEN_TYPES,PR_RATE_LIMITS}`
- `controller.authSecret.*` → `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_{NAME,KEY,MOUNT_PATH}`
- `orchestrationController.*` → `JANGAR_ORCHESTRATION_CONTROLLER_{ENABLED,NAMESPACES}`
- `supportingController.*` → `JANGAR_SUPPORTING_CONTROLLER_{ENABLED,NAMESPACES}`
- `grpc.*` → `JANGAR_GRPC_{ENABLED,HOST,PORT}` (unless overridden via `env.vars`)
- `controller.jobTtlSecondsAfterFinished` → `JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS`
- `runtime.*` → `JANGAR_{AGENT_RUNNER_IMAGE,AGENT_IMAGE,SCHEDULE_RUNNER_IMAGE,SCHEDULE_SERVICE_ACCOUNT}` (unless overridden via `env.vars`)

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
   - Render the app: `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (requires sufficient RBAC):
  - `kubectl -n agents get pods`
  - `kubectl -n agents logs deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
