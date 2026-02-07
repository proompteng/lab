# Chart Rollback Behavior and Safe Defaults

Status: Draft (2026-02-07)

## Overview
In GitOps, “rollback” typically means reverting values/manifests and letting Argo CD sync. Operators still rely on Helm semantics when debugging template behavior or when performing emergency rollbacks in non-GitOps contexts.

This doc defines rollback-safe defaults and what must remain backward compatible across chart versions.

## Goals
- Ensure the chart is rollback-safe (values changes can be reverted cleanly).
- Avoid one-way migrations in templates.
- Document the operational rollback procedure for GitOps.

## Non-Goals
- Documenting full disaster recovery scenarios (handled elsewhere).

## Current State
- Chart includes CRDs under `charts/agents/crds/` and installs them when `includeCRDs: true` (GitOps).
- GitOps desired state: `argocd/applications/agents/kustomization.yaml` (includes chart + CRDs).
- Templates avoid Helm hooks by default; optional Argo CD hooks exist under `charts/agents/templates/argocd-hooks.yaml`.

## Design
### Rollback-safe principles
- Never delete CRDs automatically on rollback.
- Additive-only changes to templates by default (new resources gated behind flags).
- Avoid renaming resources unless a migration plan exists.

### GitOps rollback procedure
1. Revert the GitOps values/manifests commit.
2. Sync Argo CD application.
3. Validate both Deployments rolled back to the prior image digests.

## Config Mapping
| Change type | Rollback risk | Mitigation |
|---|---:|---|
| New optional resource gated by flag | low | Default flag `false` and schema documentation. |
| Rename of a Service/Deployment | high | Avoid; if required, provide migration doc + dual-write period. |
| CRD schema breaking change | very high | Use versioned CRDs + conversion strategy (separate design). |

## Rollout Plan
1. Add a chart README section: “Rollback: what is safe to revert”.
2. Add CI check ensuring new templates are gated behind feature flags when appropriate.

Rollback:
- Apply the GitOps rollback procedure above.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml >/tmp/agents.yaml
kubectl -n agents rollout status deploy/agents
kubectl -n agents rollout status deploy/agents-controllers
```

## Failure Modes and Mitigations
- Rollback leaves new resources behind: mitigate by gating and by keeping selectors stable.
- Rollback reintroduces old defaults unexpectedly: mitigate by documenting default changes and versioning values.

## Acceptance Criteria
- Rolling back GitOps values returns pods to prior images and behavior within one sync.
- Chart upgrades do not require manual cleanup for optional features.

## References
- Helm template guide: https://helm.sh/docs/chart_template_guide/

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
