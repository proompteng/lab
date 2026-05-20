# Jangar Control Plane

## Purpose

The generic Agents control plane is owned by `services/agents` and the `charts/agents` Helm release. Jangar is a
domain client/consumer: it reads Agents state through the Agents service boundary and projects Torghut/Jangar readiness
without owning generic Agents CRDs, controllers, mutation APIs, or browser resource pages.

## Related docs

- `docs/jangar/agents-control-plane-new-primitives.md`

## Responsibilities

- Keep Jangar/Torghut domain readiness and proof-carry status separate from generic Agents runtime health
- Read generic Agents status through the Agents service client
- Preserve domain audit and decision state in Jangar-owned storage
- Route generic Agents create/update/delete/list/log/artifact flows to the Agents service instead of local Jangar
  controllers or browser resource pages

## API surface (example)

- `POST /v1/agents`
- `POST /v1/agent-runs`
- `POST /v1/memories`
- `POST /v1/orchestrations`
- `POST /v1/orchestration-executions`
- `GET /v1/runs/{id}`

## Standalone runs endpoint

`GET /v1/runs/{id}` provides a unified read-only view across run types. It resolves an ID to the
underlying execution (AgentRun or OrchestrationExecution), returning a normalized status payload.
This is used by UI and event consumers that only know a run ID and do not want to branch on type.

## Status aggregation

Jangar must watch and aggregate:

- AgentRun and OrchestrationRun status
- Provider-specific resource status (Argo, Temporal, etc.)
- Error conditions and retry state

## Policy enforcement

- Reject disallowed providers or service accounts
- Enforce secrets allowlists
- Gate privileged steps and deployments
- Enforce budgets and concurrency limits

## Persistence

Use `jangar-db` (CNPG) as source of truth for Jangar domain data:

- audit events
- policy decisions
- Torghut/Jangar readiness and proof-carry state

Generic Agents run metadata, idempotency keys, orchestration records, controller cache, and component heartbeats belong
to the Agents database.

## Idempotency

Generic Agents endpoints must accept an idempotency key (`deliveryId`) through the Agents service and return consistent
results on retries. Jangar should preserve idempotency for domain callbacks and event consumers without duplicating the
generic Agents run records.

## UI surface

- [Agents UI: YAML inspector + revision timeline](../agents-ui-yaml-inspector.md)

## Related docs

- [Agents control-plane filters (labels + phase)](../agents-control-plane-filters.md)
- [Agents control-plane UI polish](../agents-control-plane-polish.md)
