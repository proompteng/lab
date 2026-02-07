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
