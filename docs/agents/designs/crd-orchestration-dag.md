# CRD: Orchestration DAG Semantics

Status: Draft (2026-02-07)

## Overview
Orchestrations represent multi-step workflows. The current schema supports `spec.steps`, but the semantics around ordering, dependency graphs, and partial failure are not explicitly documented. This doc defines a DAG model that controllers can implement consistently.

## Goals
- Define step dependency semantics (DAG, not just list).
- Define failure handling and step skipping rules.

## Non-Goals
- Replacing the underlying runtime (workflow/job/temporal).

## Current State
- Orchestration CRD exists:
  - `charts/agents/crds/orchestration.proompteng.ai_orchestrations.yaml`
  - Controller: `services/jangar/src/server/orchestration-controller.ts`
- Submission path creates OrchestrationRun CRs:
  - `services/jangar/src/server/orchestration-submit.ts`
- There is no design-level contract for step dependencies beyond the raw schema.

## Design
### API shape (incremental)
Extend step schema:
```yaml
spec:
  steps:
    - name: build
      dependsOn: []
    - name: test
      dependsOn: ["build"]
```

### Execution semantics
- A step becomes runnable when all `dependsOn` steps are terminal success.
- If a dependency fails:
  - Dependent steps become `Skipped` with reason `DependencyFailed`.
- Support `continueOnFailure` (optional) for best-effort steps.

## Config Mapping
| Helm value / env var | Effect | Behavior |
|---|---|---|
| `orchestrationController.enabled` | `JANGAR_ORCHESTRATION_CONTROLLER_ENABLED` (existing pattern) | Enables orchestration DAG execution logic. |
| `orchestrationController.namespaces` | `JANGAR_ORCHESTRATION_CONTROLLER_NAMESPACES` | Scope of orchestration reconciliation. |

## Rollout Plan
1. Add API fields with backward compatibility:
  - If `dependsOn` absent, treat steps as sequential list.
2. Canary in non-prod with a 2-step DAG example.

Rollback:
- Remove `dependsOn` fields; controllers fall back to sequential behavior.

## Validation
```bash
kubectl -n agents get orchestration -o yaml | rg -n \"steps:|dependsOn\"
kubectl -n agents get orchestrationrun -o yaml | rg -n \"phase:|Skipped|DependencyFailed\"
```

## Failure Modes and Mitigations
- Cycles in dependsOn: mitigate with controller-side validation (reject with Ready=False).
- Missing dependency name: mitigate with validation and clear errors.

## Acceptance Criteria
- DAG execution is deterministic and documented.
- Sequential orchestrations continue to work unchanged.

## References
- Argo Workflows DAG concepts (widely used Kubernetes DAG runtime): https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/

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
