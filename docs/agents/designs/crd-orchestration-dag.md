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

See `docs/agents/designs/handoff-common.md`.
