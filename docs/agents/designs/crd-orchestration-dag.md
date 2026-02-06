# CRD: Orchestration DAG Semantics

Status: Draft (2026-02-06)

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
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml`, `argocd/applications/argo-workflows/*.yaml`

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`charts/agents/templates/deployment.yaml` via `.Values.controlPlane.image.*`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`charts/agents/templates/deployment-controllers.yaml` via `.Values.image.*` unless `.Values.controllers.image.*` is set): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Controllers enabled: `controllers.enabled: true` (separate `agents-controllers` deployment). See `argocd/applications/agents/values.yaml`.
- gRPC enabled: chart `grpc.enabled: true` and runtime `JANGAR_GRPC_ENABLED: "true"` in `.Values.env.vars`. See `argocd/applications/agents/values.yaml`.
- Database configured via SecretRef: `database.secretRef.name: jangar-db-app` and `database.secretRef.key: uri` (rendered as `DATABASE_URL`). See `argocd/applications/agents/values.yaml` and `charts/agents/templates/deployment.yaml`.

Note: Treat `charts/agents/**` and `argocd/applications/**` as the desired state. To verify live cluster state, run:

```bash
kubectl get application -n argocd agents
kubectl get application -n argocd froussard
kubectl get ns | rg '^(agents|agents-ci|jangar|froussard)\b'
kubectl get deploy -n agents
kubectl get crd | rg 'proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access):
  - `kubectl get pods -n agents`
  - `kubectl logs -n agents deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
