# Chart ServiceAccount Name Resolution

Status: Draft (2026-02-07)

## Overview
The Agents chart supports `serviceAccount.create` and `serviceAccount.name`, plus a separate `runnerServiceAccount` for jobs created by controllers. The naming and resolution rules must be explicit so operators can safely integrate with external IAM (IRSA, Workload Identity) and cluster policy.

## Goals
- Define deterministic ServiceAccount naming and selection for:
  - Control plane pods
  - Controllers pods
  - Runner jobs (if enabled)
- Avoid accidental reuse of default ServiceAccounts.

## Non-Goals
- Cloud-provider-specific IAM automation.

## Current State
- Values: `charts/agents/values.yaml` under `serviceAccount.*` and `runnerServiceAccount.*`.
- Templates:
  - ServiceAccount: `charts/agents/templates/serviceaccount.yaml`
  - Runner ServiceAccount: `charts/agents/templates/runner-serviceaccount.yaml`
  - Pods use `serviceAccountName: {{ include "agents.serviceAccountName" . }}` in both deployments:
    - `charts/agents/templates/deployment.yaml`
    - `charts/agents/templates/deployment-controllers.yaml`
- Runner RBAC: `charts/agents/templates/runner-rbac.yaml`.

## Design
### Naming contract
- If `serviceAccount.create=true` and `serviceAccount.name` is empty:
  - Chart creates `ServiceAccount/<release fullname>`.
- If `serviceAccount.name` is set:
  - Chart uses that name and does not create a new ServiceAccount unless explicitly requested.

### Runner ServiceAccount contract
- If `runnerServiceAccount.create=true`:
  - Chart creates `ServiceAccount/<release fullname>-runner` unless `runnerServiceAccount.name` is set.
- If `runnerServiceAccount.setAsDefault=true`:
  - Controllers default runner jobs to that ServiceAccount via env var mapping (see `charts/agents/templates/deployment-controllers.yaml` for `JANGAR_SCHEDULE_SERVICE_ACCOUNT` and workload defaults).

## Config Mapping
| Helm value | Rendered object/field | Behavior |
|---|---|---|
| `serviceAccount.create=true` | `ServiceAccount` | Create control plane/controllers ServiceAccount. |
| `serviceAccount.name` | `spec.serviceAccountName` | Explicit override of SA used by Deployments. |
| `runnerServiceAccount.create=true` | `ServiceAccount` | Create SA intended for runner Jobs. |
| `runnerServiceAccount.setAsDefault=true` | controller env/runtime | Sets default runner job SA when workload spec omits it. |

## Rollout Plan
1. Document naming in `charts/agents/README.md`.
2. Add chart validation:
   - If `runnerServiceAccount.rbac.create=true`, require `runnerServiceAccount.create=true` or a non-empty name.
3. Add controller-side logging of chosen runner ServiceAccount per Job.

Rollback:
- Revert values; existing ServiceAccounts are safe to keep.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"kind: ServiceAccount|serviceAccountName\"
kubectl -n agents get sa
```

## Failure Modes and Mitigations
- Deployments run as `default` SA unexpectedly: mitigate with schema validation and documented defaults.
- Runner jobs fail RBAC due to SA mismatch: mitigate with explicit runner SA + explicit RoleBindings.

## Acceptance Criteria
- Helm render shows a single, predictable ServiceAccount per component.
- Runner job SA selection is observable in logs and Job specs.

## References
- Kubernetes ServiceAccounts: https://kubernetes.io/docs/concepts/security/service-accounts/

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
- Argo WorkflowTemplates used by Codex (when applicable):
  - `argocd/applications/froussard/codex-autonomous-workflow-template.yaml`
  - `argocd/applications/froussard/codex-run-workflow-template-jangar.yaml`
  - `argocd/applications/froussard/github-codex-implementation-workflow-template.yaml`
  - `argocd/applications/froussard/github-codex-post-deploy-workflow-template.yaml`

### Current cluster state
As of 2026-02-07 (repo `main` desired state + best-effort live version):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps: control plane `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` and controllers `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`. See `argocd/applications/agents/values.yaml`.
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Live cluster Kubernetes version (from this environment): `v1.35.0+k3s1` (`kubectl version`).

Note: The safest “source of truth” for rollout planning is the desired state (`argocd/applications/**` + `charts/agents/**`). Live inspection may require elevated RBAC.

To verify live cluster state (requires permissions):

```bash
kubectl version --output=yaml | rg -n "serverVersion|gitVersion|platform"
kubectl get application -n argocd agents
kubectl -n agents get deploy
kubectl -n agents get pods
kubectl get crd | rg 'agents\.proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

High-signal mappings to remember:
- `env.vars.*` / `controlPlane.env.vars.*` / `controllers.env.vars.*` → container `env:` (merge precedence is defined in `docs/agents/designs/chart-env-vars-merge-precedence.md`)
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` and `JANGAR_PRIMITIVES_NAMESPACES`
- `grpc.*` and/or `env.vars.JANGAR_GRPC_*` → `JANGAR_GRPC_{ENABLED,HOST,PORT}`
- `database.*` → `DATABASE_URL` + optional `PGSSLROOTCERT`

### Rollout plan (GitOps)
1. Update code + chart + CRDs together when APIs change:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `bun run lint:argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access): apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
