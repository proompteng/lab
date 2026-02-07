# Controller Status: Timestamps + observedGeneration

Status: Draft (2026-02-07)
## Overview
Many Agents CRDs include `status.updatedAt` and `status.observedGeneration`. Consistent semantics across controllers are essential for debugging, automation, and eventual UI/CLI behavior.

This doc defines a consistent contract and identifies places in code that should be aligned.

## Goals
- Define consistent meanings for:
  - `status.observedGeneration`
  - `status.updatedAt`
  - `status.startedAt` / `status.finishedAt` where relevant
- Ensure controllers update these fields in a predictable way.

## Non-Goals
- Redesigning full status schemas for every CRD.

## Current State
- CRD types include these fields in Go:
  - `services/jangar/api/agents/v1alpha1/types.go` (e.g. `AgentStatus`, `AgentRunStatus`)
- Controllers update status using helpers (varies by resource):
  - `services/jangar/src/server/agents-controller.ts` uses `setStatus(...)` patterns and sets `observedGeneration` and timestamps in many flows.
  - Webhook status updates in `services/jangar/src/server/implementation-source-webhooks.ts` set `observedGeneration` for ImplementationSource.
- Chart does not map any values for this behavior (code-defined).

## Design
### Contract
- `observedGeneration`:
  - Set to `.metadata.generation` of the last reconciled spec that produced the current status.
- `updatedAt`:
  - Update whenever the controller writes status (even if phase unchanged).
- `startedAt` / `finishedAt`:
  - `startedAt`: first transition into Running.
  - `finishedAt`: first transition into a terminal phase.
  - Must be immutable once set.

### Implementation alignment
- Add a shared helper module for timestamp/observedGeneration updates and use it across controllers.
- Add unit tests to lock semantics (parallel to existing `agents-controller.test.ts`).

## Config Mapping
| Config surface | Behavior |
|---|---|
| (code only) | Status semantics are not configurable; must be consistent by convention and tests. |

## Rollout Plan
1. Document semantics and add tests enforcing immutability of startedAt/finishedAt.
2. Refactor controllers to use shared helpers.

Rollback:
- Revert refactor; keep tests/docs.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.generation} {.status.observedGeneration} {.status.startedAt} {.status.finishedAt} {.status.updatedAt}'; echo
```

## Failure Modes and Mitigations
- observedGeneration lag makes status misleading: mitigate by updating observedGeneration on every successful reconcile of spec.
- updatedAt not updated hides active reconciliation: mitigate with shared helper and tests.

## Acceptance Criteria
- All controllers follow the same semantics for observedGeneration and timestamps.
- startedAt/finishedAt are immutable once set.

## References
- Kubernetes generation and status patterns: https://kubernetes.io/docs/concepts/overview/working-with-objects/kubernetes-objects/

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
