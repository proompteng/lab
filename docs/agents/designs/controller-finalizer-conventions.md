# Controller Finalizer Conventions

Status: Draft (2026-02-06)

## Overview
Finalizers ensure controllers can perform cleanup before an object is fully deleted (e.g., deleting external runtimes). Inconsistent finalizer naming and behavior can cause stuck deletions or skipped cleanup.

This doc defines naming conventions and lifecycle behavior for Agents controllers.

## Goals
- Standardize finalizer naming and behavior.
- Ensure deletion cleanup is best-effort but does not deadlock deletion.

## Non-Goals
- Guaranteeing cleanup success in all cases (network outages, permission failures).

## Current State
- AgentRun uses a runtime cleanup finalizer:
  - `services/jangar/src/server/agents-controller.ts` uses finalizer `agents.proompteng.ai/runtime-cleanup`.
- Cleanup attempts call `cancelRuntime(...)` and then remove the finalizer via patch.
- Other CRDs may not use finalizers consistently.

## Design
### Naming
- Format: `<group>/<purpose>` under the API group domain, e.g.:
  - `agents.proompteng.ai/runtime-cleanup`
  - `orchestration.proompteng.ai/runtime-cleanup` (if needed)

### Behavior
- On deletion timestamp:
  - Attempt cleanup with bounded timeouts.
  - Never re-add finalizers once deletion has started.
  - Always remove the finalizer after cleanup attempt, even on failure (log error).

## Config Mapping
| Proposed env var | Intended behavior |
|---|---|
| `JANGAR_CONTROLLER_FINALIZER_CLEANUP_TIMEOUT_MS` | Upper bound for cleanup steps before removing finalizer anyway. |

## Rollout Plan
1. Document naming conventions and current AgentRun behavior.
2. Add bounded-time cleanup and ensure finalizer removal happens even on failure.
3. Add tests covering deletion paths for AgentRun (and others if applicable).

Rollback:
- Revert cleanup timeout logic; keep naming conventions.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.finalizers}'; echo
kubectl -n agents delete agentrun <name> --wait=false
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.deletionTimestamp}'; echo
```

## Failure Modes and Mitigations
- Finalizer never removed, object stuck deleting: mitigate with bounded cleanup time and “remove anyway” behavior.
- Cleanup fails silently: mitigate with explicit logs/events on cleanup failure.

## Acceptance Criteria
- Deleting an AgentRun does not deadlock due to cleanup failures.
- Finalizer names are consistent and documented.

## References
- Kubernetes finalizers: https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/

