# Jangar control-plane pages for new primitives (design)

## Summary

This document defines the routing, API contracts, UI components, and rollout plan to add control-plane UI pages for
new primitives: Tool, ToolRun, Signal, SignalDelivery, ApprovalPolicy, Budget, SecretBinding, Schedule, Artifact, and
Workspace. The goal is to make these primitives first-class in the Jangar control-plane UI with consistent list/detail
views, relationship navigation, and status insight.

## Goals

- Ship list and detail pages for all new primitives with consistent navigation and filters.
- Expose the core spec + status fields in structured summaries alongside raw YAML.
- Provide relationship links between primitives (ex: Tool -> ToolRun, Signal -> SignalDelivery).
- Reuse existing control-plane API endpoints and streaming mechanisms where possible.
- Ensure sensitive data (secrets, payloads) is redacted or summarized appropriately.

## Non-goals

- Implement CRUD editing flows in the UI.
- Add new runtime adapters or controller behaviors for these primitives.
- Build a generic dashboard outside of the control-plane UI shell.
- Implement historical analytics or long-term storage beyond current status + events.

## Background / current state

- The control-plane UI already supports a generic list/detail shell via `PrimitiveListPage` and `PrimitiveDetailPage`.
- The control-plane API exposes read-only access to resources, events, and streaming updates under
  `/api/agents/control-plane/*`.
- Existing primitives (Agent, AgentRun, Orchestration, etc.) use consistent list/detail route structure.

The new primitives should follow the same contract and page layout, then layer in primitive-specific summary panels and
relationship navigation.

## Routing

### Route map

All routes live under `/agents-control-plane` and use the same namespace + label selector search state.

- `/agents-control-plane/tools` → Tool list
- `/agents-control-plane/tools/$name` → Tool detail
- `/agents-control-plane/tool-runs` → ToolRun list
- `/agents-control-plane/tool-runs/$name` → ToolRun detail
- `/agents-control-plane/signals` → Signal list
- `/agents-control-plane/signals/$name` → Signal detail
- `/agents-control-plane/signal-deliveries` → SignalDelivery list
- `/agents-control-plane/signal-deliveries/$name` → SignalDelivery detail
- `/agents-control-plane/approvals` → ApprovalPolicy list
- `/agents-control-plane/approvals/$name` → ApprovalPolicy detail
- `/agents-control-plane/budgets` → Budget list
- `/agents-control-plane/budgets/$name` → Budget detail
- `/agents-control-plane/secret-bindings` → SecretBinding list
- `/agents-control-plane/secret-bindings/$name` → SecretBinding detail
- `/agents-control-plane/schedules` → Schedule list
- `/agents-control-plane/schedules/$name` → Schedule detail
- `/agents-control-plane/artifacts` → Artifact list
- `/agents-control-plane/artifacts/$name` → Artifact detail
- `/agents-control-plane/workspaces` → Workspace list
- `/agents-control-plane/workspaces/$name` → Workspace detail

### URL state

- All list/detail pages accept `?namespace=<ns>&labelSelector=<selector>`.
- Detail pages propagate `namespace` in the search state to allow direct linking.
- Relationship links should preserve `namespace` unless an explicit cross-namespace reference is present.

## API needs

### Existing endpoints (reuse)

- `GET /api/agents/control-plane/resources?kind=<Kind>&namespace=<ns>`
  - Optional: `labelSelector`, `phase`, `runtime`, `limit`.
- `GET /api/agents/control-plane/resource?kind=<Kind>&name=<name>&namespace=<ns>`
- `GET /api/agents/control-plane/events?kind=<Kind>&name=<name>&namespace=<ns>&uid=<uid>`
- `GET /api/agents/control-plane/stream?namespace=<ns>` (SSE resource updates)
- `GET /api/agents/control-plane/summary?namespace=<ns>`

These endpoints are sufficient for list/detail/event rendering as long as each primitive kind is registered in the
control-plane kind resolver and resource map.

### Additions for new primitives

1. **Summary coverage**
   - Extend the summary endpoint to include: ToolRun, SignalDelivery, ApprovalPolicy, Budget, SecretBinding, Schedule,
     Artifact, Workspace.
   - This enables the overview tiles and counts to surface new primitives without ad-hoc list calls.

2. **Relationship filters (label selectors)**
   - Standardize labels/refs so the UI can filter related resources using `labelSelector`:
     - `ToolRun` list filtered by `spec.toolRef.name` or `metadata.labels["tools.proompteng.ai/tool"]`.
     - `SignalDelivery` list filtered by `spec.signalRef.name` or `metadata.labels["signals.proompteng.ai/signal"]`.
     - `Schedule` list filtered by `spec.targetRef` labels.
   - If CRDs do not expose labels today, add a controller-side label projection for these references.

3. **Payload and secret redaction**
   - Ensure responses do not include secret material.
   - For payload-heavy fields (SignalDelivery payloads, ToolRun inputs), return a size/count summary in list views and
     allow explicit expansion in detail views with redaction on sensitive keys.

4. **Optional: per-primitive event limits**
   - Allow an `eventsLimit` query or reuse `limit` to keep event lists compact on busy namespaces.

## UI components

### Shared list/detail shell

Use the existing primitives shell as the baseline:

- **List**: `PrimitiveListPage` with namespace + label selector filters, count, and a consistent fields grid.
- **Detail**: `PrimitiveDetailPage` with summary cards, Conditions, Events, and full YAML tabs.

### Primitive-specific list fields

List pages should surface 3–4 high-signal fields per primitive (already aligned with existing list definitions):

- **Tool**: image, command, args, timeout.
- **ToolRun**: tool ref, delivery ID, run ID, started time.
- **Signal**: channel, description, payload shape, last delivery.
- **SignalDelivery**: signal ref, delivery ID, payload shape, delivered time.
- **ApprovalPolicy**: mode, default decision, subjects count, last decision.
- **Budget**: CPU/memory/tokens/dollars limits.
- **SecretBinding**: allowed secrets, subjects count, first subject, phase.
- **Schedule**: cron, timezone, target kind/name.
- **Artifact**: storage ref, TTL, URI, checksum.
- **Workspace**: size, access modes, storage class, TTL.

### Primitive-specific detail summaries

Detail pages should expand the list fields with the highest-signal status fields:

- **Tool**: service account, working dir, TTL after finish, runtime labels.
- **ToolRun**: started/finished timestamps, status phase, runtime run ID.
- **Signal**: delivery status/last delivery, payload schema keys.
- **SignalDelivery**: delivered timestamp, delivery attempts, last error (if present).
- **ApprovalPolicy**: subjects list preview, escalation policy, last decision.
- **Budget**: usage (tokens/dollars) vs limits, last reset window.
- **SecretBinding**: subjects list preview, policy phase, allowed secrets preview.
- **Schedule**: cron expression, timezone, target ref, next/last fire if present.
- **Artifact**: storage ref, checksum, URI, retention/lifecycle details.
- **Workspace**: storage class, access modes, provisioned volume name, TTL.

### Relationship panels (new components)

Add lightweight panels to the detail pages to link related resources (using label selectors or ref fields):

- **Tool → ToolRuns**: list recent ToolRuns filtered by tool ref or label.
- **Signal → SignalDeliveries**: list recent deliveries filtered by signal ref or label.
- **Schedule → Target runs**: link to OrchestrationRuns/AgentRuns triggered by the schedule.
- **Budget → Enforced resources**: list resources with `spec.budgetRef` or label.
- **SecretBinding → Bound subjects**: link to Agents/Tools that reference the binding (if labels are added).
- **Artifact → Consumers**: link to runs that reference artifact output URIs (future).
- **Workspace → Attached runs**: list runs referencing workspace name (future).

Relationship panels should cap results (ex: 10) and include a “View all” link to the list page with a pre-filled
`labelSelector`.

### Page state & empty states

- Show clear empty states per primitive (ex: “No tool runs found”).
- When a primitive is missing status or specs (newly created), show placeholder dashes and a short hint.
- For payload-heavy primitives (SignalDelivery, ToolRun), show count + size summary and require an explicit
  “Reveal payload” action on the detail page.

### Navigation updates

- Add new primitives to the control-plane overview sections with proper grouping:
  - Resources: Tool
  - Runs: ToolRun
  - Policies: ApprovalPolicy, Budget, SecretBinding
  - Signals: Signal, SignalDelivery
  - Storage: Artifact, Workspace
  - Orchestration: Schedule

## Rollout plan

1. **Phase 0: docs + alignment**
   - Publish this doc and validate primitive fields with controller owners.
   - Confirm label/relationship strategy for runs and deliveries.

2. **Phase 1: API readiness**
   - Ensure all new kinds are wired in `primitives-control-plane` and `RESOURCE_MAP`.
   - Extend `/summary` coverage to include all new kinds.
   - Add or validate label projections for relationship filtering.

3. **Phase 2: UI pages**
   - Ship list + detail routes for each primitive using the shared shell.
   - Add primitive-specific summary fields.

4. **Phase 3: relationship panels**
   - Add “recent related resources” panels and filtered “View all” links.
   - Add payload reveal UX with redaction.

5. **Phase 4: polish + observability**
   - Ensure SSE updates trigger list refresh for all new kinds.
   - Add basic telemetry for list/detail load errors.

## Risks and mitigations

- **Sensitive payload exposure**: enforce redaction + explicit reveal for payload-heavy primitives.
- **Missing labels for relationships**: add controller label projection or fallback to ref-based filters.
- **High cardinality lists**: use default limits and encourage label filtering.
- **Namespace confusion**: always surface namespace in summary and keep query params in URLs.

## Open questions

- Which fields are safe to reveal for SignalDelivery payloads and ToolRun inputs by default?
- Should ToolRun detail pages support a log viewer similar to AgentRun logs?
- Do schedules emit a stable “run label” for correlation with runs and deliveries?
- Are any of these primitives cluster-scoped and should the UI offer a cluster-scope toggle?

## Appendix: related files

- `services/jangar/src/components/agents-control-plane-primitives.tsx`
- `services/jangar/src/components/agents-control-plane-overview.tsx`
- `services/jangar/src/data/agents-control-plane.ts`
- `services/jangar/src/routes/agents-control-plane/*`
- `services/jangar/src/routes/api/agents/control-plane/*`
