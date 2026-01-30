# Agents Control-Plane Filters (Labels + Phase)

Status: Draft (2026-01-30)

## Summary

Introduce first-class label and phase filters across the agents control-plane API, CLI, and UI so operators can
consistently scope listings and watches of Agents, AgentRuns, ImplementationSpecs, and related primitives.
The change standardizes query parameters, ensures labels are stored in a consistent location, and keeps all
filters optional for backward compatibility.

## Background

Today, filtering is inconsistent across surfaces:

- The Jangar UI for the agents control plane already exposes label selector and phase/runtime filters for some
  lists, but the behavior and query naming are not fully standardized.
- The control-plane API includes a resources endpoint used by the UI; other external `/v1/*` endpoints do not
  document label or phase filtering.
- Some CRDs carry labels in `spec` fields, others rely on `metadata.labels`, which makes selector behavior ambiguous.

This doc proposes a uniform filter contract so list/watch operations behave the same in the API, CLI, and UI.

## Goals

- Provide a consistent label selector interface for list/watch across Agent, AgentRun, ImplementationSpec,
  ImplementationSource, Orchestration, OrchestrationExecution, and related primitives.
- Provide phase filtering for run-like resources (AgentRun and OrchestrationExecution).
- Ensure UI and CLI can round-trip filters via query parameters and flags.
- Keep all changes backward compatible and additive.

## Non-goals

- Introducing complex field selectors beyond label/phase.
- Altering how phases are computed or introducing new phases in this change.
- Redesigning the control-plane UI; only incremental filter UI changes are in scope.

## Definitions

- **Label selector**: Kubernetes-style selector string (e.g. `team=platform,env in (prod,staging)`), used
  to match `metadata.labels`.
- **Phase**: A normalized status string for run-like resources. For AgentRun: `Pending`, `Running`, `Succeeded`,
  `Failed`, `Cancelled`. For OrchestrationExecution: same set, plus any mapped provider states.

## Proposed API changes

### 1) External Jangar API (`/v1/*`)

Add optional query parameters to all list/watch endpoints:

- `labelSelector`: string, Kubernetes label selector syntax.
- `phase`: string or comma-separated list of phases (only valid for run-like resources).
- `runtime`: string (optional, run-like resources only).
- `limit`: integer (existing).
- `watch`: boolean (if supported by the endpoint).

Endpoints impacted:

- `GET /v1/agents`
- `GET /v1/agent-runs`
- `GET /v1/implementation-specs`
- `GET /v1/implementation-sources`
- `GET /v1/orchestrations`
- `GET /v1/orchestration-executions`

Example:

```
GET /v1/agent-runs?labelSelector=team=platform,env=prod&phase=Running,Pending&runtime=workflow
```

Notes:

- `phase` and `runtime` are ignored for non-run resources.
- `labelSelector` applies to `metadata.labels` only.
- API responses include the normalized `status.phase` to support client filtering and display.

### 2) Control-plane UI API (`/api/agents/control-plane/resources`)

Standardize the query parameters for the UI-facing resources endpoint:

- `kind` (required)
- `namespace` (optional)
- `labelSelector` (optional)
- `phase` (optional; accepts comma-separated list)
- `runtime` (optional)
- `limit` (optional)
- `stream` (optional; watch)

Behavior matches the `/v1/*` contract. The endpoint should accept both `labelSelector` and the legacy
`label_selector` to keep existing clients working.

### 3) Validation and error handling

- Invalid label selectors should return `400` with a clear error message.
- Unknown phases should return `400` on run resources, and be ignored on non-run resources.
- When `phase` is provided on list/watch endpoints for non-run resources, the API returns all results (and logs
  a structured warning server-side).

## Data model changes

### Labels

To make selection consistent, labels are stored in `metadata.labels` for all agent-related CRDs.

- **Source of truth:** `metadata.labels` on all resources.
- **Backward compatibility:** when a resource includes `spec.labels` (e.g. ImplementationSpec), the API/controller
  mirrors these into `metadata.labels` on create/update.
- **Migration:** a one-time reconciliation job (or controller reconciliation loop) can backfill missing
  `metadata.labels` from `spec.labels` for existing objects.

Labeling conventions (recommended, not required):

- `team`, `env`, `provider`, `runtime`, `source`, `runType`, `owner`.

### Phase

- `status.phase` must be present on run-like resources (AgentRun and OrchestrationExecution).
- The control plane normalizes provider-specific runtime statuses into these phases.
- Phase is included in list responses so clients can filter further without additional calls.

## CLI changes (`agentctl`)

Add label/phase flags to list/watch commands, consistent with `kubectl` conventions:

- `-l, --selector <labelSelector>`: pass through to API label selector.
- `--label <k=v>`: repeatable; translated into a selector string.
- `--phase <phase[,phase]>`: run-only list/watch filters.
- `--runtime <type>`: run-only list/watch filters (existing or added where missing).

Examples:

```
agentctl run list -n agents --phase Running,Pending -l team=platform
agentctl impl list --label owner=codex --label env=staging
agentctl agent watch -l provider=codex
```

Behavior:

- `--label` and `--selector` are mutually additive; the CLI combines them into a single selector.
- In kube mode, these flags map to Kubernetes label selector query parameters.
- In gRPC mode, these flags map to the new `/v1/*` query parameters.

## UI changes

### Global filter behavior

- Filters are encoded in the URL query string to enable sharing and reload persistence.
- Apply filters immediately on change (debounced for text inputs), with a clear reset button.
- Active filters are displayed as removable chips.

### Pages to update

- **Agent Runs**: add a multi-select Phase filter, keep Runtime filter, and ensure Label Selector is present.
- **Implementation Specs**: add/standardize the Label Selector filter.
- **Agents / Orchestrations**: add Label Selector and, for run-like pages, Phase filter where relevant.

### UI schema

- Label selector input uses the Kubernetes string format; inline helper text should link to docs/examples.
- Phase filter supports multiple selection and maps to comma-separated values in the API query.

## Backward compatibility

- All new parameters are optional; existing list and watch clients remain valid.
- `label_selector` continues to work as an alias to `labelSelector` for the control-plane UI endpoint.
- For resources without `metadata.labels`, filters are a best-effort match after backfilling from `spec.labels`.
- CLI defaults remain unchanged when no flags are provided.

## Rollout plan

1. Add label/phase handling to `/v1/*` list endpoints and document them.
2. Standardize and validate query params on `/api/agents/control-plane/resources`.
3. Update agentctl flags and CLI help text.
4. Update control-plane UI filter components and URL handling.
5. Run a one-time reconciliation to backfill `metadata.labels` where needed.

## Observability

- Emit structured logs for filter parsing errors and invalid selectors.
- Track filter usage rates to validate rollout (percent of requests with labelSelector/phase).

## Open questions

- Should we accept repeated `phase` parameters in addition to comma-separated values?
- Do we want a dedicated `labels` object in `/v1/*` responses, or rely solely on `metadata.labels`?
- Should label selector parsing be shared by all endpoints (library) or per-route?
