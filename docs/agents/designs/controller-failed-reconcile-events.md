# Controller Failed Reconcile: Kubernetes Events

Status: Draft (2026-02-06)

## Overview
When reconciles fail, the current primary signal is logs (and possibly status conditions). Kubernetes Events are a useful operational tool (visible via `kubectl describe`) and can improve MTTR, especially for failures like missing secrets, RBAC, or invalid spec fields.

## Goals
- Emit Kubernetes Events for actionable reconcile failures.
- Avoid noisy event storms for transient errors.

## Non-Goals
- Replacing logs or status conditions.

## Current State
- Controllers update status for many CRDs via `setStatus(...)` helpers:
  - `services/jangar/src/server/agents-controller.ts`
  - `services/jangar/src/server/implementation-source-webhooks.ts` (status updates)
- Kubernetes client wrapper currently supports listing Events but not creating them:
  - `services/jangar/src/server/primitives-kube.ts` includes `listEvents(...)` but no `createEvent(...)`.
- The chart does not configure event emission.

## Design
### Event emission rules
- For non-retryable spec/config errors:
  - Emit `Warning` event with a stable reason (e.g. `InvalidSpec`, `MissingSecret`, `Forbidden`).
- For transient errors:
  - Update status condition + log; emit an event only on first occurrence and then rate-limit (per-object).

### Implementation approach
- Extend `KubernetesClient` in `primitives-kube.ts` to support creating Events:
  - Use `events.k8s.io/v1` if available; fall back to `v1` Events if necessary.
- Add an event helper in controllers to avoid duplication and to enforce rate limiting.

## Config Mapping
| Helm value (proposed) | Env var (proposed) | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_CONTROLLER_EVENTS_ENABLED` | `JANGAR_CONTROLLER_EVENTS_ENABLED` | Enables/disables event emission (default `true`). |
| `controllers.env.vars.JANGAR_CONTROLLER_EVENTS_RATE_LIMIT_PER_MIN` | `JANGAR_CONTROLLER_EVENTS_RATE_LIMIT_PER_MIN` | Caps event spam per object. |

## Rollout Plan
1. Add event emission behind `JANGAR_CONTROLLER_EVENTS_ENABLED=true` with conservative rate limits.
2. Canary in non-prod and confirm event volume is manageable.
3. Enable in prod; document common reasons in runbooks.

Rollback:
- Set `JANGAR_CONTROLLER_EVENTS_ENABLED=false`.

## Validation
```bash
kubectl -n agents get events --sort-by=.metadata.creationTimestamp | tail -n 50
kubectl -n agents describe agentrun <name> | rg -n \"Events:\"
```

## Failure Modes and Mitigations
- Event storms during reconcile loops: mitigate with strict per-object rate limiting and “first occurrence only” logic.
- Events leak sensitive info: mitigate by sanitizing messages and never including secret values.

## Acceptance Criteria
- Non-retryable spec errors produce a Kubernetes Event with a stable reason.
- Event volume remains bounded under failure conditions.

## References
- Kubernetes Events: https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.30/#event-v1-core

