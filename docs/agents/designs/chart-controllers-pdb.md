# Chart Controllers PodDisruptionBudget

Status: Draft (2026-02-07)

## Overview
The chart can deploy a separate controllers Deployment (`agents-controllers`), but the chart’s PodDisruptionBudget (PDB) template currently only targets the control plane pods. This creates an availability gap: controllers may all be evicted during node drains or cluster maintenance even when the control plane is protected.

## Goals
- Add optional PDB support for `agents-controllers`.
- Keep backward compatibility for existing installs using `podDisruptionBudget.*`.

## Non-Goals
- Enforcing a single organization-wide disruption policy.

## Current State
- Existing PDB template: `charts/agents/templates/poddisruptionbudget.yaml`
  - Selects `{{ include "agents.selectorLabels" . }}` (control plane).
- Controllers selector labels differ: `charts/agents/templates/_helpers.tpl` (`agents.controllersSelectorLabels`).
- Values: `charts/agents/values.yaml` exposes `podDisruptionBudget.*` (single set).
- Cluster desired state: `argocd/applications/agents/values.yaml` does not enable a PDB.

## Design
### Proposed values
Add component-scoped PDBs:
- `controlPlane.podDisruptionBudget` (defaults to existing `podDisruptionBudget`)
- `controllers.podDisruptionBudget` (new)

### Defaults
- Keep existing `podDisruptionBudget.enabled=false`.
- When controllers are enabled, recommend enabling a PDB with `maxUnavailable: 1` for controllers.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `podDisruptionBudget.*` | `PodDisruptionBudget/agents` | Backward compatible control plane PDB. |
| `controllers.podDisruptionBudget.enabled=true` | `PodDisruptionBudget/agents-controllers` | Prevents full controller eviction during voluntary disruptions. |

## Rollout Plan
1. Add `controllers.podDisruptionBudget` with defaults (disabled).
2. Enable in non-prod and validate node-drain behavior.
3. Enable in prod after confirming controllers can roll without downtime.

Rollback:
- Disable `controllers.podDisruptionBudget.enabled`.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true --set controllers.podDisruptionBudget.enabled=true | rg -n \"kind: PodDisruptionBudget\"
kubectl -n agents get pdb
```

## Failure Modes and Mitigations
- PDB too strict blocks node drain: mitigate with `maxUnavailable: 1` and by matching replicas.
- Selector mismatch means PDB protects nothing: mitigate with render-time tests and explicit selector labels.

## Acceptance Criteria
- When enabled, a PDB exists for `agents-controllers` selecting the correct pods.
- Node drains do not evict all controller replicas at once.

## References
- Kubernetes PodDisruptionBudget: https://kubernetes.io/docs/tasks/run-application/configure-pdb/

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
