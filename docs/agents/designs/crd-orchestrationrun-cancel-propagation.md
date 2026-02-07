# CRD: OrchestrationRun Cancel Propagation

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
Operators need reliable cancellation semantics for OrchestrationRuns. Cancelling should propagate to all active underlying runtimes (Jobs/Workflows/etc) and update status/conditions in a predictable way.

## Goals
- Define cancel request API and status transitions.
- Ensure cancel propagates to underlying resources best-effort.

## Non-Goals
- Guaranteeing immediate termination in all runtimes.

## Current State
- OrchestrationRun CRD exists:
  - `charts/agents/crds/orchestration.proompteng.ai_orchestrationruns.yaml`
- Controller: `services/jangar/src/server/orchestration-controller.ts`
- Orchestration submission stores externalRunId in DB: `services/jangar/src/server/orchestration-submit.ts`.

## Design
### API shape
Add:
```yaml
spec:
  cancel: true
```
or a `spec.desiredState: Cancelled`.

### Controller behavior
- If cancel requested:
  - Attempt to delete/terminate underlying runtime resources.
  - Set `status.phase=Cancelled` and condition `Cancelled=True` once cancellation is acknowledged.
  - If already terminal success/failure: ignore cancel request (no-op) and record a condition reason.

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_ORCHESTRATION_CANCEL_TIMEOUT_MS` | bound | Upper bound for cancellation attempts before marking cancelled anyway. |

## Rollout Plan
1. Implement cancel semantics in controller with a feature flag.
2. Canary in non-prod by cancelling a running orchestration and confirming propagation.

Rollback:
- Disable cancel support flag; rely on manual deletion of underlying resources.

## Validation
```bash
kubectl -n agents patch orchestrationrun <name> --type=merge -p '{\"spec\":{\"cancel\":true}}'
kubectl -n agents get orchestrationrun <name> -o yaml | rg -n \"Cancelled|phase\"
```

## Failure Modes and Mitigations
- Underlying runtime ignores deletion: mitigate by best-effort termination + clear status messaging.
- Cancel flips terminal success incorrectly: mitigate by making cancel a no-op for terminal runs.

## Acceptance Criteria
- Cancelling a running OrchestrationRun results in a terminal Cancelled state and best-effort runtime termination.
- Cancel is a no-op for already terminal runs.

## References
- Kubernetes graceful termination concepts: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination

