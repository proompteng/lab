# Chart Canary with Argo Rollouts (Optional Integration)

Status: Draft (2026-02-07)

## Overview
Today the Agents chart uses Kubernetes Deployments. For safer production changes (especially to controllers), operators may want progressive delivery. This doc proposes a chart-compatible integration path with Argo Rollouts without making it a hard dependency.

## Goals
- Provide a supported canary rollout pattern for `agents` and `agents-controllers`.
- Keep default behavior as plain Deployments.

## Non-Goals
- Replacing Argo CD as the GitOps orchestrator.
- Adding bespoke rollout tooling.

## Current State
- Chart renders `kind: Deployment` only:
  - `charts/agents/templates/deployment.yaml`
  - `charts/agents/templates/deployment-controllers.yaml`
- GitOps desired state for install lives in:
  - `argocd/applications/agents/application.yaml`
  - `argocd/applications/agents/kustomization.yaml`

## Design
### Proposed values
Add:
- `progressiveDelivery.enabled` (default `false`)
- `progressiveDelivery.provider: argo-rollouts`
- `progressiveDelivery.canarySteps` (list)

When enabled:
- Render `kind: Rollout` (Argo Rollouts CRD) instead of `Deployment`.
- Keep Services/selectors stable.

### Safety defaults
- Default to 1-step canary with manual pause.
- Keep max surge/unavailable conservative.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `progressiveDelivery.enabled=false` | `Deployment` | Current behavior. |
| `progressiveDelivery.enabled=true` | `Rollout` | Progressive delivery driven by Argo Rollouts controller. |

## Rollout Plan
1. Add chart support behind `progressiveDelivery.enabled=false`.
2. Install Argo Rollouts in a non-prod cluster; enable for controllers only.
3. After stable, enable for control plane if desired.

Rollback:
- Disable `progressiveDelivery.enabled` to fall back to Deployments (requires careful migration; document as “one-time switch”).

## Validation
```bash
helm template agents charts/agents --set progressiveDelivery.enabled=true | rg -n \"kind: Rollout\"
kubectl get crd | rg \"rollouts\\.argoproj\\.io\"
kubectl -n agents get rollout
```

## Failure Modes and Mitigations
- Rollouts CRD not installed: mitigate by render-time validation when feature enabled.
- Switching kinds breaks `kubectl rollout` workflows: mitigate by documenting operational differences and migration steps.

## Acceptance Criteria
- Enabling the flag renders valid manifests and does not break the default install path.
- Controllers can be canaried progressively without changing Services.

## References
- Argo Rollouts documentation: https://argo-rollouts.readthedocs.io/

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
