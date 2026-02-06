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
- Go API types: `services/jangar/api/agents/v1alpha1/types.go`
- CRD generation entrypoint: `services/jangar/api/agents/generate.go`
- Generated CRDs shipped with the chart: `charts/agents/crds/`
- Examples used by CI/local validation: `charts/agents/examples/`

### Regenerating CRDs

```bash
# Regenerates `charts/agents/crds/*` via controller-gen, then patches/normalizes CRDs.
go generate ./services/jangar/api/agents

# Validates CRDs + examples + rendered chart assumptions.
scripts/agents/validate-agents.sh
```

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`, desired state in Git):
- `agents` Argo CD app (namespace `agents`) installs `charts/agents` via kustomize-helm (release `agents`, chart `version: 0.9.1`, `includeCRDs: true`). See `argocd/applications/agents/kustomization.yaml`.
- Images pinned for `agents`:
  - Control plane (`deploy/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` (from `controlPlane.image.*`).
  - Controllers (`deploy/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809` (from `image.*`).
- Namespaced reconciliation: `controller.namespaces: [agents]`, `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- `jangar` Argo CD app (namespace `jangar`) deploys the product UI/control plane plus default “primitive” CRs (AgentProvider/Agent/Memory/etc). See `argocd/applications/jangar/kustomization.yaml`.
- Jangar image pinned for `jangar` (`deploy/jangar`): `registry.ide-newton.ts.net/lab/jangar:19448656@sha256:15380bb91e2a1bb4e7c59dce041859c117ceb52a873d18c9120727c8e921f25c` (from `argocd/applications/jangar/kustomization.yaml`).

Render the exact YAML Argo CD applies:

```bash
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/jangar > /tmp/jangar.rendered.yaml
```

Verify live cluster state (requires kubeconfig):

```bash
mise exec kubectl@1.30.6 -- kubectl get application -n argocd agents
mise exec kubectl@1.30.6 -- kubectl get application -n argocd jangar
mise exec kubectl@1.30.6 -- kubectl get ns | rg '^(agents|agents-ci|jangar)\b'
mise exec kubectl@1.30.6 -- kubectl get deploy -n agents
mise exec kubectl@1.30.6 -- kubectl get deploy -n jangar
mise exec kubectl@1.30.6 -- kubectl get crd | rg 'proompteng\.ai'
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl rollout status -n jangar deploy/jangar
```

### Rollout plan (GitOps)
1. Regenerate CRDs and commit the updated `charts/agents/crds/*`.
2. Update `charts/agents/Chart.yaml` `version:` if the CRD changes are shipped to users; keep GitOps pinned version in sync (`argocd/applications/agents/kustomization.yaml`).
3. Merge to `main`; Argo CD applies updated CRDs (`includeCRDs: true`).

### Validation
- Local:
  - `scripts/agents/validate-agents.sh`
  - `mise exec helm@3.15.4 -- helm lint charts/agents`
- Cluster (requires kubeconfig):
  - `mise exec kubectl@1.30.6 -- kubectl get crd | rg 'agents\.proompteng\.ai|orchestration\.proompteng\.ai|approvals\.proompteng\.ai'`
