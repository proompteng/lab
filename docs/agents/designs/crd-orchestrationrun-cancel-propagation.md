# CRD: OrchestrationRun Cancel Propagation

Status: Draft (2026-02-07)

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
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- CRDs packaged by chart: `charts/agents/crds/`
- Go types (when generated): `services/jangar/api/agents/v1alpha1/`
- Validation pipeline: `scripts/agents/validate-agents.sh`

