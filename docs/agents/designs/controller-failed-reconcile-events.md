# Controller Failed Reconcile: Kubernetes Events

Status: Draft (2026-02-07)

Docs index: [README](../README.md)

## Overview

When reconciles fail, the current primary signal is logs (and possibly status conditions). Kubernetes Events are a useful operational tool (visible via `kubectl describe`) and can improve MTTR, especially for failures like missing secrets, RBAC, or invalid spec fields.

## Goals

- Emit Kubernetes Events for actionable reconcile failures.
- Avoid noisy event storms for transient errors.

## Non-Goals

- Replacing logs or status conditions.

## Current State

- Controllers update status for many CRDs via `setStatus(...)` helpers:
  - `services/agents/src/server/agents-controller`
  - `services/agents/src/server/implementation-source-webhooks.ts` (status updates)
- Kubernetes client wrapper currently supports listing Events but not creating them:
  - `services/jangar/src/server/primitives-kube.ts` includes `listEvents(...)` but no `createEvent(...)`.
- Watch processing is not observable beyond container logs:
  - `services/jangar/src/server/kube-watch.ts` currently only parses and forwards watch events to callbacks.
  - There is no per-resource kind/namespace/event-type telemetry and no storm-specific circuit-breaker metadata for reconciliation loops.
- The chart does not configure event emission.

### Immediate Assessment Snapshot (2026-03-04)

Recent read-only checks show:

- `jangar` namespace is mostly healthy:
  - `jangar`, `jangar-worker`, `jangar-db`, and supporting services are running and ready.
- `swarm jangar-control-plane` is `Active` with `phase: Active`; all stage schedules report `Active` and recent run timestamps are advancing.
- Cluster event stream includes restart churn from controller rollouts and a known unrelated `posthog-migrate-f2gvk` secret-miss event, but no sustained crash loop pattern from the control-plane container itself.
- `kube-watch`-based controllers are still the dominant change path in core control-plane loops (`agents-controller`, `supporting-primitives-controller`, `primitives-reconciler`, `orchestration-controller`, `control-plane-cache`, `agentctl-grpc`).

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

| Helm value (proposed)                                              | Env var (proposed)                            | Intended behavior                                 |
| ------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------- |
| `controllers.env.vars.JANGAR_CONTROLLER_EVENTS_ENABLED`            | `JANGAR_CONTROLLER_EVENTS_ENABLED`            | Enables/disables event emission (default `true`). |
| `controllers.env.vars.JANGAR_CONTROLLER_EVENTS_RATE_LIMIT_PER_MIN` | `JANGAR_CONTROLLER_EVENTS_RATE_LIMIT_PER_MIN` | Caps event spam per object.                       |

## Rollout Plan

1. Add event emission behind `JANGAR_CONTROLLER_EVENTS_ENABLED=true` with conservative rate limits.
2. Canary in non-prod and confirm event volume is manageable.
3. Enable in prod; document common reasons in runbooks.

## Design Decision (2026-03-04)

### Top selected design change for this stage

Address repeatability and incident detection first by instrumenting watch processing itself, then wire downstream policy on that signal.

#### Chosen option: per-watch metrics + bounded visibility pipeline (primary)

- Add metrics in `services/jangar/src/server/metrics.ts`:
  - `jangar_watch_event_total{resource,namespace,event_type,source,kind}` (counter)
  - `jangar_watch_event_errors_total{resource,namespace,error}` (counter)
  - `jangar_watch_event_parse_failures_total{resource,namespace}` (counter)
- Add lightweight optional rate guard in `services/jangar/src/server/kube-watch.ts`:
  - only emit metrics for `resource`+`namespace` combinations that appear in configured watch windows (controller namespaces + `ResourceMap` entries used by `startResourceWatch`)
  - avoid unbounded label cardinality by normalizing unknown kinds to `other`.
- Use these metrics as the primary high-signal path for:
  - storm detection (e.g., `resource=swarm`, `event_type=MODIFIED`, sustained p95 over incident thresholds),
  - watch reliability monitoring (parse failures and stderr emissions),
  - controller-level impact correlation (`recordReconcileDurationMs` and `recordAgentConcurrency` already available in controllers).

#### Alternatives considered

1. Events-only rollout
   - Pros:
     - Operator-visible immediately in `kubectl describe`.
   - Cons:
     - Limited aggregation and low signal for long-tail event rate patterns unless a secondary scraper is already running.
     - Higher noise risk and operational overhead without metric-first alerting.

2. Full controller-runtime migration
   - Pros:
     - Cleaner lifecycle and backpressure semantics at process level.
   - Cons:
     - Larger surface change with high risk for this stage; changes the controller substrate across all surfaces.

3. Chosen hybrid path (metrics first, events only where severity matters)
   - Pros:
     - Minimal risk, highest immediate reliability value, aligns with incident learnings from the March 1 reconcile storm.
   - Cons:
     - Requires alerting policy updates (already required by the project’s required-check workflow).

#### Implementation scope for this PR

- This stage updates the design artifact only:
  - It formalizes event telemetry and watch-storm guardrails as the first milestone before implementation code changes.
  - It aligns with the existing post-incident playbook recommendation in:
    - `docs/incidents/2026-03-01-jangar-control-plane-reconcile-storm.md`
  - It explicitly separates metrics from event emission in rollout order to reduce rollout risk.

Rollback:

- Set `JANGAR_CONTROLLER_EVENTS_ENABLED=false`.

## Validation

```bash
kubectl -n agents get events --sort-by=.metadata.creationTimestamp | tail -n 50
kubectl -n agents describe agentrun <name> | rg -n \"Events:\"
kubectl -n agents get events --field-selector involvedObject.kind=Swarm --sort-by=.metadata.creationTimestamp | tail -n 50
```

## Failure Modes and Mitigations

- Event storms during reconcile loops: mitigate with strict per-object rate limiting and “first occurrence only” logic.
- Events leak sensitive info: mitigate by sanitizing messages and never including secret values.

## Acceptance Criteria

- Non-retryable spec errors produce a Kubernetes Event with a stable reason.
- Event volume remains bounded under failure conditions.

## References

- Kubernetes Events: https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.30/#event-v1-core
