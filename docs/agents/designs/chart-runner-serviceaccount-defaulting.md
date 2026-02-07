# Chart Runner ServiceAccount Defaulting

Status: Draft (2026-02-07)

## Overview
Agents controllers schedule Kubernetes Jobs for agent runs. The chart includes a `runnerServiceAccount` block and multiple runtime defaults (`runtime.scheduleServiceAccount`, workload defaults, and controller env vars). The defaulting hierarchy must be explicit so operators can ensure jobs run with the intended permissions.

## Goals
- Define a single, deterministic defaulting chain for runner Jobs.
- Avoid accidental privilege escalation (jobs using a more-privileged SA than intended).

## Non-Goals
- Replacing per-run workload overrides in CRDs.

## Current State
- Values:
  - `runnerServiceAccount.*` in `charts/agents/values.yaml`
  - `runtime.scheduleServiceAccount` in `charts/agents/values.yaml`
  - `controller.defaultWorkload.serviceAccountName` in `charts/agents/values.yaml`
- Template mappings (controllers):
  - `JANGAR_SCHEDULE_SERVICE_ACCOUNT` from `runtime.scheduleServiceAccount`: `charts/agents/templates/deployment-controllers.yaml`
  - default workload SA: `JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT` from `controller.defaultWorkload.serviceAccountName`: `charts/agents/templates/deployment-controllers.yaml`
- Runtime uses these env vars while creating Jobs: `services/jangar/src/server/agents-controller.ts`.

## Design
### Defaulting chain (recommended)
1. `AgentRun.spec.workload.serviceAccountName` (per-run explicit)
2. `Agent.spec.security.allowedServiceAccounts` (policy gate; deny if not allowed)
3. `controller.defaultWorkload.serviceAccountName` (cluster/operator default)
4. `runtime.scheduleServiceAccount` (legacy compatibility)
5. Fallback: chart-created `runnerServiceAccount` when `runnerServiceAccount.setAsDefault=true`

### Chart changes
- Prefer a single chart value that maps to the controller default runner SA, e.g.:
  - `runner.defaultServiceAccountName`
and deprecate `runtime.scheduleServiceAccount` for job execution.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.defaultWorkload.serviceAccountName` | `JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT` | Primary default SA for agent-run Jobs. |
| `runtime.scheduleServiceAccount` | `JANGAR_SCHEDULE_SERVICE_ACCOUNT` | Legacy/secondary default; should be deprecated for Jobs. |
| `runnerServiceAccount.setAsDefault` | (chart behavior) | If enabled, set the above to created runner SA name. |

## Rollout Plan
1. Document the defaulting chain in chart README and in controller logs.
2. Add warnings when legacy `runtime.scheduleServiceAccount` is used for Jobs.
3. Introduce the new `runner.defaultServiceAccountName` value and migrate GitOps values.

Rollback:
- Keep both env vars supported; revert to legacy configuration.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT|JANGAR_SCHEDULE_SERVICE_ACCOUNT\"
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT|JANGAR_SCHEDULE_SERVICE_ACCOUNT\"
```

## Failure Modes and Mitigations
- Job runs under an unintended SA: mitigate by making the defaulting chain explicit and enforcing allowed-service-accounts policy.
- Missing SA causes Job create failure: mitigate with schema validation and chart-created SA defaults.

## Acceptance Criteria
- Render output shows exactly one “default runner SA” configured for controllers.
- Controller logs indicate the SA used for each created Job.

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
