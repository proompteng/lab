# Orchestration Submit Deduplication (Delivery ID)

Status: Draft (2026-02-06)

## Overview
Orchestration run submission is triggered by external events (e.g., webhooks). Duplicate deliveries are common. The current system deduplicates submissions by `deliveryId` using the primitives store.

This doc formalizes the dedupe contract and proposes chart/controller knobs to keep it safe in production.

## Goals
- Guarantee idempotent orchestration submissions per `(namespace, orchestrationRef, deliveryId)`.
- Ensure dedupe state is durable across controller restarts.

## Non-Goals
- Exactly-once processing across multiple clusters.

## Current State
- Submission code: `services/jangar/src/server/orchestration-submit.ts`
  - Looks up `store.getOrchestrationRunByDeliveryId(input.deliveryId)` and returns existing run if present.
  - Applies an `OrchestrationRun` resource with label `jangar.proompteng.ai/delivery-id`.
- Store layer: `services/jangar/src/server/primitives-store.ts` (durable DB-backed store).
- Chart wiring for DB URL is required for controllers: `charts/agents/templates/deployment-controllers.yaml`.

## Design
### Contract
- `deliveryId` MUST be treated as globally unique per provider.
- If a duplicate `deliveryId` is received:
  - Return the existing `OrchestrationRun` record and (if present) the external CR state.
- Dedupe retention:
  - Keep dedupe records for a minimum window (e.g. 7 days) to handle delayed retries.

### Proposed config
- `JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` (default `7`)
- Store cleanup job (optional) to prune old dedupe rows.

## Config Mapping
| Proposed Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` | `JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` | How long to retain dedupe records. |

## Rollout Plan
1. Document dedupe semantics and label usage.
2. Add retention config and a safe default.
3. Add a periodic cleanup job (optional) once validated in staging.

Rollback:
- Disable cleanup job and keep retention high.

## Validation
```bash
kubectl -n agents get orchestrationrun -l jangar.proompteng.ai/delivery-id --show-labels
kubectl -n agents logs deploy/agents-controllers | rg -n \"deliveryId|idempotent\"
```

## Failure Modes and Mitigations
- Dedupe table grows unbounded: mitigate with retention + cleanup job.
- deliveryId collisions between providers: mitigate by namespacing deliveryId with provider prefix if needed.

## Acceptance Criteria
- Duplicate deliveries do not create duplicate orchestration runs.
- Dedupe state survives controller restarts.

## References
- HTTP request idempotency (general definition): https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods
