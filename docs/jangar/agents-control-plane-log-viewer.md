# Jangar control-plane agent run log viewer (design)

## Summary

This document defines the UX, API, and data contracts for a first-class log viewer in the Jangar control-plane UI for
AgentRun execution logs. The goal is to make on-call and operators able to understand run progress quickly, follow live
output safely, and correlate log output with run status/events without leaving the control-plane surface.

## Goals

- Provide a reliable, low-latency log viewer for AgentRun pods/containers inside the Jangar UI.
- Make it easy to jump between pods and containers, follow live output, and copy/download logs.
- Preserve a single source of truth for log access (Jangar control-plane APIs) and avoid direct cluster access from
  browsers.
- Support large logs without blocking the UI via chunked retrieval and streaming.
- Expose consistent, typed contracts for UI + API consumers.
- Enforce access controls (RBAC) aligned with existing control-plane permissions.

## Non-goals

- Long-term log retention or cross-cluster aggregation (e.g., Loki/Elastic). This design relies on Kubernetes pod logs
  and existing artifact links.
- Full-text log analytics, alerting, or correlation search.
- Replacing the `agentctl` CLI or gRPC log streaming.
- Building a generic log viewer for all workloads beyond AgentRun pods.

## Background / current state

- The Jangar UI already has a Logs tab on the AgentRun detail page that calls
  `GET /api/agents/control-plane/logs` with `tailLines`, `pod`, and `container` parameters.
- The current endpoint returns log text plus a pod/container listing; it is a single snapshot and does not stream.
- The control plane already streams resource/status updates via SSE at `/api/agents/control-plane/stream`.
- The agentctl gRPC service supports streaming logs (`StreamAgentRunLogs`) by proxying kubectl.

This design builds on those primitives and fills the gaps around streaming, pagination, and UX polish.

## UX flow

### Entry points

- AgentRun detail page (`/agents-control-plane/agent-runs/:name`) → Logs tab.
- Optional deep link from run list entries and activity steps.

### Primary flow

1. User opens an AgentRun detail page and switches to Logs.
2. The UI fetches a snapshot (`tailLines` default 200) for the primary pod + main container.
3. The UI renders logs in a monospace panel with
   - pod and container selectors,
   - a tail-lines input,
   - refresh and “follow” toggle,
   - copy and download actions.
4. If “follow” is enabled, a streaming connection is established and new lines append in real time.
5. When the user switches pod/container, the viewer resets to a snapshot and (if enabled) restarts streaming.

### Secondary flows

- **No pods found**: show a neutral empty state with “no pods yet” and a retry.
- **Multiple pods**: show status pills (`Running`, `Succeeded`, `Failed`) in the selector.
- **Init containers**: label with `(init)` and keep separate from main containers.
- **Large output**: show “truncated” labels when the result is capped and offer a “increase tail” action.
- **Artifacts / external logs**: show detected log links (from status fields) below the log panel.

### UX requirements

- Auto-scroll on follow; disable auto-scroll if the user scrolls up.
- Preserve line wrapping and ANSI color stripping (or optional ANSI rendering if later desired).
- Allow in-panel search (client-side) for short snapshots.
- Always show the selected pod/container and tail lines in the URL query string for shareable links.

## Data contracts

### Snapshot response (existing)

**Endpoint**: `GET /api/agents/control-plane/logs`

Query:

- `name` (required): AgentRun name.
- `namespace` (required): Kubernetes namespace.
- `pod` (optional): pod name; defaults to a running pod if present.
- `container` (optional): container name; defaults to main container.
- `tailLines` (optional): number of lines to return (1–5000).

Response:

```json
{
  "ok": true,
  "name": "run-123",
  "namespace": "agents",
  "pods": [
    {
      "name": "run-123-abc",
      "phase": "Running",
      "containers": [
        { "name": "agent", "type": "main" },
        { "name": "init-sync", "type": "init" }
      ]
    }
  ],
  "logs": "...",
  "pod": "run-123-abc",
  "container": "agent",
  "tailLines": 200
}
```

Failure shape:

```json
{ "ok": false, "message": "pod not found", "status": 404, "raw": { "pod": "..." } }
```

### Streaming response (new)

**Endpoint**: `GET /api/agents/control-plane/logs/stream`

Query:

- `name` (required)
- `namespace` (required)
- `pod` (optional)
- `container` (optional)
- `sinceTime` (optional, RFC3339)
- `sinceSeconds` (optional)
- `tailLines` (optional)
- `follow` (optional, default true)

**Protocol**: Server-Sent Events (`text/event-stream`).

Event types:

- `meta`: emitted once on connection (selected pod/container, limits).
- `line`: log line frames.
- `end`: end-of-stream marker (non-follow mode or completed run).
- `error`: recoverable error (connection may remain open if possible).
- `heartbeat`: keepalive every 5s.

Example:

```
event: meta
id: 1

data: {"pod":"run-123-abc","container":"agent","tailLines":200,"truncated":false}

event: line
id: 2

data: {"stream":"stdout","timestamp":"2026-01-30T19:11:40.123Z","text":"starting step 1"}

event: end
id: 3

data: {"reason":"run_completed"}
```

Notes:

- The server should coalesce chunked output into line frames when possible.
- `id` increments monotonically to support client reconnection.
- If `follow=false`, the server should emit `end` once the snapshot is finished.

### UI state contract

Client state (per open log stream):

```ts
{
  name: string
  namespace: string
  pod: string | null
  container: string | null
  tailLines: number
  follow: boolean
  lastEventId: string | null
  truncated: boolean
}
```

## API endpoints

### Existing (snapshot)

- `GET /api/agents/control-plane/logs`
  - Backed by Kubernetes `pod/log` API.
  - Caps `tailLines` at 5000.
  - Returns pod list for selector.

### New (stream)

- `GET /api/agents/control-plane/logs/stream`
  - SSE that proxies Kubernetes log streaming.
  - Supports `follow=false` for a one-shot stream.
  - Uses the same pod/container selection logic as the snapshot endpoint.

### Optional enhancements

- `GET /api/agents/control-plane/logs/download`
  - Same query parameters as snapshot.
  - Returns `text/plain` for direct download (useful for long tail lines).

## Authorization / RBAC

- Only authenticated users with read access to AgentRuns in the specified namespace can access logs.
- RBAC rule: `agents.proompteng.ai/agentruns/logs` (read) or equivalent existing “AgentRuns:read” permission.
- Namespace scoping must be enforced server-side; clients cannot access logs from namespaces they lack access to.
- Audit log entries should be emitted for log access (user, namespace, name, pod, container, time).

## Error states

### Request validation

- `400` if `name` or `namespace` is missing.
- `400` for invalid `tailLines` (`<=0` or non-numeric).

### Resource selection

- `404` if pod not found.
- `404` if container not found or pod has no containers.

### Runtime failures

- `401/403` for auth or RBAC failures.
- `500` for Kubernetes errors (e.g., API timeouts, log stream errors).
- `502/503` for upstream runtime outages (if logs are served by a runtime adapter).

### UI behavior

- Always show the error inline and preserve the last successful log output.
- Provide a “Retry” action and a “Back to run list” escape hatch.

## Pagination & streaming strategy

### Snapshot paging

- `tailLines` is the primary paging control for short snapshots.
- For larger snapshots (e.g., 2k+ lines), the UI should surface a banner when results are truncated.
- The snapshot endpoint should expose `truncated: boolean` and `maxTailLines` in the response (new fields).

### Streaming

- Use SSE for log streaming to match existing control-plane streaming patterns.
- Support `Last-Event-ID` for replays on reconnect.
- Maintain a bounded in-memory ring buffer of the last N lines on the server to support short reconnect gaps.

### Historical paging (future)

- Kubernetes logs do not support “before” cursors for older logs; full history requires external storage.
- If/when a log backend (Loki, S3 artifacts) is added, introduce a `cursor`-based API with `before`/`after` tokens.

## Rollout plan

1. **Phase 0: doc + contracts**
   - Publish this design doc.
   - Align on endpoint names and SSE contract.
2. **Phase 1: backend streaming**
   - Add `/api/agents/control-plane/logs/stream` using the same selection logic as `/logs`.
   - Implement SSE framing and heartbeats.
3. **Phase 2: UI enhancements**
   - Add follow toggle, auto-scroll, and status badges.
   - Persist pod/container/tailLines in the URL.
4. **Phase 3: quality improvements**
   - Copy/download, search filter, and truncated banners.
   - Audit logging + metrics.

## Metrics & observability

### Metrics

- `jangar_agent_run_log_requests_total{namespace, status}`
- `jangar_agent_run_log_streams_active{namespace}`
- `jangar_agent_run_log_stream_errors_total{namespace, reason}`
- `jangar_agent_run_log_bytes_total{namespace}`
- `jangar_agent_run_log_latency_ms{namespace, endpoint}`

### Logs / tracing

- Log access audit: user, namespace, run name, pod, container, tailLines.
- Stream lifecycle logs (open, close, error) tagged with `stream_id`.

## Security considerations

- Never expose kube tokens or raw kubectl errors to the UI.
- Strip ANSI escape codes (or render safely) to avoid terminal injection or XSS.
- Enforce output size limits to prevent memory pressure in the UI.

## Open questions

- Should streaming logs reuse the agentctl gRPC service internally or call Kubernetes directly?
- Do we need a dedicated “log export” endpoint for long snapshots or is client-side download sufficient?
- Should we integrate external log backends as a follow-on (and which is preferred)?

## Appendix: related docs and code

- `services/jangar/src/routes/api/agents/control-plane/logs.ts`
- `services/jangar/src/data/agents-control-plane.ts`
- `services/jangar/src/routes/agents-control-plane/agent-runs/$name.tsx`
- `docs/jangar/primitives/control-plane.md`
- `docs/agents/agentctl-cli-design.md`
