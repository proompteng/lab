# Chart Control Plane Image Override Precedence

Status: Draft (2026-02-07)

## Overview
The Agents control plane runs as the `agents` Deployment. The chart supports an explicit `controlPlane.image.*` override separate from `image.*`. This doc defines a contract for selecting that image and recommended promotion paths.

## Goals
- Clarify image selection rules for the control plane.
- Support independent pinning/promotion between control plane and controllers.

## Non-Goals
- Supporting multiple control plane deployments per release.

## Current State
- Template: `charts/agents/templates/deployment.yaml` computes `$imageRepo/$imageTag/$imageDigest` using `controlPlane.image.*` with fallbacks to `image.*`.
- Values: `charts/agents/values.yaml` under `controlPlane.image.*`.
- GitOps pins the control plane image in `argocd/applications/agents/values.yaml`.

## Design
### Precedence for control plane image
1. `controlPlane.image.*` (if field non-empty)
2. `image.*` (root defaults)

### Promotion policy
- Canary controllers first (separate deployment), then promote control plane.
- When changing API behavior that affects CRD reconciliation, promote controllers and control plane in lockstep (same git SHA + digest set).

## Config Mapping
| Helm value | Rendered image for `agents` | Notes |
|---|---|---|
| `controlPlane.image.repository` | repo | Defaults to `image.repository` if empty. |
| `controlPlane.image.tag` | tag | Defaults to `image.tag` if empty. |
| `controlPlane.image.digest` | digest | Defaults to `image.digest` if empty. |
| `controlPlane.image.pullSecrets` | imagePullSecrets | Defaults to `image.pullSecrets` if empty. |

## Rollout Plan
1. Document contract in `charts/agents/README.md`.
2. Add `imagePolicy.requireDigest` enforcement in prod (optional, see `chart-image-digest-tag-precedence.md`).
3. Promote via GitOps value change; wait for rollout status.

Rollback:
- Revert digest and re-sync.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"kind: Deployment|name: agents$|image:\"
kubectl -n agents rollout status deploy/agents
```

## Failure Modes and Mitigations
- Control plane and controllers drift to incompatible versions: mitigate via CI rule enforcing same git SHA tag in prod overlays.
- Digest omitted causes unexpected image pull changes: mitigate with digest enforcement.

## Acceptance Criteria
- Rendered image for `agents` is predictable from values.
- Operators can roll back by reverting a single digest in GitOps.

## References
- Helm best practices for values: https://helm.sh/docs/chart_best_practices/values/

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
