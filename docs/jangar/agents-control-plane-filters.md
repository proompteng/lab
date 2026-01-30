# Jangar agents control-plane filters (design)

## Summary

Add first-class label and phase filters to the agents control-plane API, CLI (`agentctl`), and Jangar UI. The goal is to
make large namespaces usable by letting operators slice resources by labels (Kubernetes selector syntax) and by run phase
(Pending/Running/Succeeded/Failed/Cancelled) without changing existing defaults.

## Goals

- Provide consistent label + phase filtering across REST API, gRPC/CLI, and UI.
- Support Kubernetes label selector syntax (`key=value`, `key in (...)`, `!key`, etc.).
- Enable quick run-phase slicing for `AgentRun` and `OrchestrationRun` list views and streams.
- Preserve backward compatibility for existing API clients and UI deep links.
- Keep server-side filtering as the source of truth; avoid heavy client-side filtering for large datasets.

## Non-goals

- Full-text search over labels/annotations or status fields.
- Cross-namespace queries (filtering remains namespace-scoped).
- New persistence or indexing layers; labels remain on CRDs and are queried via Kubernetes APIs.

## Background / current state

- The control-plane REST list endpoint (`GET /api/agents/control-plane/resources`) already accepts a
  `labelSelector` and `phase` query parameter, but only uses `phase` for `AgentRun` and does not expose a
  cohesive UI/CLI surface.
- The SSE stream (`GET /api/agents/control-plane/stream`) broadcasts all resource events in a namespace without
  server-side label or phase filtering.
- The CLI (`agentctl`) list commands support `--selector` / `--label-selector` for most primitives in gRPC mode, but the
  UX is inconsistent with the UI and there is no run-phase filter across list commands.

This design unifies those behaviors and makes filters visible, consistent, and shareable across surfaces.

## Data model

### Labels

- Filters rely on Kubernetes labels (`metadata.labels`). No new schema fields are required.
- Label selectors must follow Kubernetes label selector syntax as implemented by `kubectl`/API server.
- Reserved prefixes remain unchanged; recommend using `jangar.proompteng.ai/*` or existing `codex.*` labels for
  system-generated values, and team-specific prefixes for custom tags.

### Run phases

- `AgentRun.status.phase` and `OrchestrationRun.status.phase` are the primary phase values:
  - `Pending` | `Running` | `Succeeded` | `Failed` | `Cancelled`
- Unknown or missing phases are treated as `Unknown` in summaries but are excluded when a phase filter is applied.

## API design

### REST endpoints (control-plane)

#### 1) List resources (existing, extend)

**Endpoint**: `GET /api/agents/control-plane/resources`

**Query params**:
- `kind` (required)
- `namespace` (optional, default `agents`)
- `limit` (optional, default server-defined)
- `labelSelector` (optional, K8s selector string)
- `phase` (optional, for run-like kinds)
- `phases` (optional, comma-separated list; supersedes `phase`)
- `runtime` (optional, for `AgentRun` only)

**Behavior**:
- `labelSelector` applies to all kinds (Kubernetes list with `-l` selector).
- `phase`/`phases` applies to run-like kinds (`AgentRun`, `OrchestrationRun`).
- `phases` is an OR over the supplied values.
- If both `phase` and `phases` are provided, `phases` wins.

#### 2) Stream resources (new filters)

**Endpoint**: `GET /api/agents/control-plane/stream`

**Query params**:
- `namespace` (optional, default `agents`)
- `labelSelector` (optional)
- `phase` / `phases` (optional, run-like kinds only)
- `runtime` (optional, `AgentRun` only)

**Behavior**:
- Server applies filters before emitting SSE events.
- For non-run kinds, only `labelSelector` applies.
- For run kinds, both label selector and phase filters are applied.

#### 3) Summary (extend)

**Endpoint**: `GET /api/agents/control-plane/summary`

**Query params**:
- `namespace` (optional)
- `labelSelector` (optional)

**Behavior**:
- When `labelSelector` is present, totals and phase counts reflect only matching resources.
- When absent, behavior remains unchanged.

### Backward-compatible aliases

- `label_selector` is accepted as an alias for `labelSelector` in all endpoints.
- Existing `phase` parameter remains supported; `phases` is additive.

### Response changes

No breaking response shape changes. Filter metadata can be optionally echoed back in responses to simplify UI state
rehydration:

```json
{
  "ok": true,
  "kind": "AgentRun",
  "namespace": "agents",
  "filters": {
    "labelSelector": "codex.stage=implementation",
    "phases": ["Running", "Pending"],
    "runtime": "workflow"
  },
  "items": []
}
```

## CLI design (`agentctl`)

### List commands (all primitives)

Add consistent flags to `list` and `watch` commands:

- `--label-selector <expr>` (alias: `--selector`)
- `--phase <phase>` (run kinds only)
- `--phases <p1,p2,...>` (run kinds only)

Examples:

```
agentctl run list --label-selector "codex.stage=implementation" --phases Running,Pending
agentctl orchestrationrun list --phase Failed
agentctl run watch --label-selector "team=infra" --phase Running
```

### gRPC and kube modes

- gRPC mode passes `label_selector`, `phase`, and `runtime` to the gRPC list methods.
- kube mode uses the same selector/phase filters and performs server-side filtering when possible (Kubernetes label
  selector; phase filter applied client-side only when the server lacks native support).

### Help + completion

- Ensure new flags appear in `agentctl help` output and shell completion scripts.
- Keep flag names consistent with existing patterns (`label-selector` preferred over `labels`).

## UI design

### Filter bar (AgentRun + OrchestrationRun list views)

Add a filter bar to the control-plane list screens:

- **Label selector** input (K8s selector syntax with inline helper text and examples).
- **Phase pills**: Pending, Running, Succeeded, Failed, Cancelled.
- **Quick presets**: `Active` (Pending + Running), `Completed` (Succeeded + Failed + Cancelled).

Filters should update the URL query string so state is shareable:

```
/agents-control-plane/agent-runs?labelSelector=codex.stage%3Dimplementation&phases=Running,Pending
```

### Filter behavior

- Filters apply server-side by passing query params to control-plane APIs.
- UI caches the last-used label selector per user (local storage) and rehydrates on load.
- Phase pills are multi-select (OR). Selecting a pill toggles it.

### Status + empty states

- When filters are active, show a “filtered” badge and a one-click clear action.
- Empty state should distinguish between “no data” and “no matches for current filters.”

## Backward compatibility

- Existing API clients with no filters behave identically.
- `phase` stays supported; `phases` is optional and additive.
- `label_selector` continues to work as an alias for `labelSelector`.
- UI defaults remain unchanged: no filters applied, same list ordering and limits.

## Rollout plan

1) **API + gRPC**: Add `labelSelector`/`phase`/`phases` to REST endpoints and gRPC list methods where missing.
2) **CLI**: Surface new flags in `agentctl` list/watch commands; update help and docs.
3) **UI**: Add filter bar, update URL query sync, and wire to API.
4) **Telemetry**: Add basic metrics for filter usage and error rates (see below).

## Observability

- Metric: `jangar_control_plane_filter_requests_total` (labels: endpoint, has_label_selector, has_phase).
- Metric: `jangar_control_plane_filter_errors_total` (labels: endpoint, error_code).
- Log filter payloads at debug level for troubleshooting (avoid logging sensitive label values if they can contain PII).

## Open questions

- Should we add dedicated label helpers for common Codex fields (repo, issue, stage), or rely on raw selectors?
- Do we need phase filtering for `ToolRun` or other run-like primitives beyond `AgentRun`/`OrchestrationRun`?
- Should UI persist filters per-kind or globally across the control-plane views?

## Appendix

- Run phase definitions live in `docs/jangar/primitives/agent.md` and `docs/jangar/primitives/orchestration.md`.
- Existing control-plane stream endpoint: `GET /api/agents/control-plane/stream`.
- Existing resources list endpoint: `GET /api/agents/control-plane/resources`.
