# Chart Resources: Component Overrides

Status: Draft (2026-02-07)

## Overview
The Agents chart exposes `resources` as a global default and also supports component-specific overrides (`controlPlane.resources`, `controllers.resources`). These overrides are implemented in templates but not explicitly documented, which increases the chance of accidentally starving controllers or the control plane in production.

## Goals
- Document the current override behavior and make it explicit.
- Recommend production defaults for control plane vs controllers.
- Ensure resource settings are observable via Helm render and `kubectl`.

## Non-Goals
- Autosizing resources automatically.
- Changing scheduling/affinity policies (handled separately).

## Current State
- Values:
  - Global: `charts/agents/values.yaml` → `resources`
  - Control plane override: `charts/agents/values.yaml` → `controlPlane.resources`
  - Controllers override: `charts/agents/values.yaml` → `controllers.resources`
- Template wiring:
  - Control plane uses `$resources := .Values.controlPlane.resources | default .Values.resources` in `charts/agents/templates/deployment.yaml`.
  - Controllers uses `$resources := .Values.controllers.resources | default .Values.resources` in `charts/agents/templates/deployment-controllers.yaml`.
- Cluster desired state sets `resources.requests` globally in `argocd/applications/agents/values.yaml` but does not set per-component overrides.

## Design
### Contract
- If a component override is an empty object (`{}`), it is treated as “unset” and the component inherits from global `resources`.
- Production guidance:
  - Controllers should have explicit requests/limits tuned for reconcile throughput.
  - Control plane should have explicit requests/limits tuned for serving traffic and background tasks.

### Recommended chart documentation
Add a chart README section:
- “Resource precedence” with examples showing:
  - Global only
  - Controllers-only override
  - Control-plane-only override

## Config Mapping
| Helm value | Pod resources target | Behavior |
|---|---|---|
| `resources` | `deploy/agents` and `deploy/agents-controllers` | Baseline default for all components. |
| `controlPlane.resources` | `deploy/agents` | Overrides global for control plane only. |
| `controllers.resources` | `deploy/agents-controllers` | Overrides global for controllers only. |

## Rollout Plan
1. Document precedence (no behavior change).
2. In GitOps, set explicit per-component requests for production.
3. Add alerting to catch CPU throttling / OOMKilled during canary (operational follow-up).

Rollback:
- Revert values changes; chart behavior remains backward compatible.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"resources:|requests:|limits:\"
kubectl -n agents get deploy agents -o yaml | rg -n \"resources:\"
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"resources:\"
```

## Failure Modes and Mitigations
- Controllers starve and fall behind: mitigate by explicit controller requests and by monitoring reconcile lag.
- Control plane throttles under API load: mitigate by explicit control plane requests and HPA (if enabled).
- Values changes accidentally apply to both components: mitigate by using component overrides and validating rendered manifests.

## Acceptance Criteria
- Documentation clearly explains precedence and examples.
- Production GitOps values can size controllers separately from the control plane.

## References
- Kubernetes resource requests/limits: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/

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
