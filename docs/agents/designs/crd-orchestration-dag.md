# CRD: Orchestration DAG Semantics

Status: Draft (2026-02-06)

## Production / GitOps (source of truth)
These design notes are kept consistent with the live *production desired state* (GitOps) and the in-repo `charts/agents` chart.

### Current production deployment (desired state)
- Namespace: `agents`
- Argo CD app: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml` (chart `charts/agents`, chart version `0.9.1`, release `agents`)
- Values overlay: `argocd/applications/agents/values.yaml` (pins images + digests, DB SecretRef, gRPC, and `envFromSecretRefs`)
- Additional in-cluster resources (GitOps-managed): `argocd/applications/agents/*.yaml` (Agent/Provider, SecretBinding, VersionControlProvider, samples)

### Chart + code (implementation)
- Chart entrypoint: `charts/agents/Chart.yaml`
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- Templates: `charts/agents/templates/`
- CRDs installed by the chart: `charts/agents/crds/`
- Example CRs: `charts/agents/examples/`
- Control plane + controllers code: `services/jangar/src/server/`

### Values ↔ env mapping (common)
- `.Values.env.vars` → base Pod `env:` for control plane + controllers (merged; component-local values win).
- `.Values.controlPlane.env.vars` → control plane-only overrides.
- `.Values.controllers.env.vars` → controllers-only overrides.
- `.Values.envFromSecretRefs[]` → Pod `envFrom.secretRef` (Secret keys become env vars at runtime).

### Rollout + validation (production)
- Rollout path: edit `argocd/applications/agents/` (and/or `charts/agents/`), commit, and let Argo CD sync.
- Render exactly like Argo CD (Helm v3 + kustomize):
  ```bash
  helm lint charts/agents
  mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.rendered.yaml
  ```
- Validate in-cluster (requires RBAC allowing reads in `agents`):
  ```bash
  kubectl -n agents get deploy,svc,pdb,cm
  kubectl -n agents describe deploy agents
  kubectl -n agents describe deploy agents-controllers || true
  kubectl -n agents logs deploy/agents --tail=200
  kubectl -n agents logs deploy/agents-controllers --tail=200 || true
  ```

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
