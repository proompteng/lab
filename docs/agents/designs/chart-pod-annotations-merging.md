# Chart Pod Annotations Merging

Status: Draft (2026-02-07)

## Overview
The chart applies `.Values.podAnnotations` and `.Values.podLabels` to both the control plane pod template and the controllers pod template. Operators often need different annotations per component (e.g., different scraping, sidecar settings, or rollout controls). Today that requires global annotations that may not be appropriate for both.

## Goals
- Define current behavior and its limits.
- Propose component-scoped pod metadata overrides without breaking existing installs.

## Non-Goals
- Standardizing on a specific mesh/observability stack.

## Current State
- Values: `charts/agents/values.yaml` includes `podAnnotations` and `podLabels` (global).
- Templates:
  - Control plane pod template: `charts/agents/templates/deployment.yaml`
  - Controllers pod template: `charts/agents/templates/deployment-controllers.yaml`
- No `controlPlane.podAnnotations` / `controllers.podAnnotations` values exist.

## Design
### Proposed values
Add component-scoped fields:
- `controlPlane.podAnnotations` / `controlPlane.podLabels`
- `controllers.podAnnotations` / `controllers.podLabels`

### Precedence
1. Component-scoped annotations/labels (if set)
2. Global `podAnnotations` / `podLabels`

### Backward compatibility
- Keep global keys working unchanged.
- Implement component keys as additive overrides.

## Config Mapping
| Helm value | Pod template target | Behavior |
|---|---|---|
| `podAnnotations` | both Deployments | Global baseline annotations. |
| `controlPlane.podAnnotations` | `deploy/agents` only | Overrides/extends globals for control plane. |
| `controllers.podAnnotations` | `deploy/agents-controllers` only | Overrides/extends globals for controllers. |

## Rollout Plan
1. Add new values keys with no defaults (no behavior change).
2. Update `values.schema.json` and README examples.
3. Migrate any component-specific annotations from global to component keys in GitOps.

Rollback:
- Remove component keys and move annotations back to global.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"annotations:\"
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.metadata.annotations}'; echo
kubectl -n agents get deploy agents-controllers -o jsonpath='{.spec.template.metadata.annotations}'; echo
```

## Failure Modes and Mitigations
- Global annotation breaks controllers (or control plane): mitigate by component scoping.
- Annotation changes do not trigger rollout: mitigate via checksum annotations (see separate design).

## Acceptance Criteria
- Component-scoped pod metadata can be set without affecting the other component.
- Backward compatibility: existing installs using `podAnnotations` continue to work.

## References
- Kubernetes pod template metadata: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

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
