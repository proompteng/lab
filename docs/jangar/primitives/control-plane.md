# Jangar Control Plane

## Purpose

Jangar is the control plane for all primitives in `*.proompteng.ai`. It is the only external API
surface for creating and managing Agent, Memory, Orchestration, and supporting primitives.

## Related docs

- `docs/jangar/agents-control-plane-new-primitives.md`

## Responsibilities

- Create/update/delete primitives (CRDs) on behalf of users
- Enforce policy and guardrails (security, budgets, approvals)
- Normalize provider-agnostic specs into provider bindings
- Aggregate status and expose a unified API
- Persist audit logs and lifecycle history in `jangar-db`

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

Use `jangar-db` (CNPG) as source of truth for:

- run metadata
- audit events
- policy decisions
- cross-run correlation

## Idempotency

All Jangar endpoints must accept an idempotency key (`deliveryId`), stored in the database,
and return consistent results on retries.

## UI surface

- [Agents UI: YAML inspector + revision timeline](../agents-ui-yaml-inspector.md)

## Related docs

- [Agents control-plane filters (labels + phase)](../agents-control-plane-filters.md)
- [Agents control-plane UI polish](../agents-control-plane-polish.md)
