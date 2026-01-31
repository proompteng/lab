# Agents UI: YAML Inspector + Revision Timeline

## Summary

This doc proposes a YAML inspector and revision timeline for the Agents control-plane UI. The goal
is to make it fast and safe to understand what an Agent spec is today, how it evolved, and why it
changed, with minimal backend and UI latency.

## Goals

- Give operators and developers a clear, read-only view of the effective Agent YAML.
- Provide a revision timeline with diffs, metadata, and audit trail context.
- Make it easy to copy, compare, and rollback (if allowed) while preserving guardrails.
- Keep the UI responsive for large specs and long revision histories.

## Non-goals

- Editing YAML directly in the control-plane UI (future work).
- Showing runtime logs or execution traces (covered by other UI surfaces).
- Rendering provider-specific YAML beyond a read-only view of resolved specs.

## UX flow

### Entry points

- Agent list -> select Agent -> "YAML" tab.
- Agent detail -> "Revision timeline" side panel toggle.

### YAML inspector

1. Default view shows the latest resolved YAML for the selected Agent, falling back to the raw spec when resolved
   output is unavailable.
2. A compact selector allows choosing a revision by timestamp or version.
3. Two modes: "Raw YAML" and "Normalized JSON" (read-only).
4. "Copy" and "Download" buttons for the current view.

### Revision timeline

1. Timeline defaults to latest 20 revisions, lazy-load on scroll.
2. Each revision item shows:
   - version
   - author or service
   - source (API, UI, automation)
   - timestamp
   - optional change summary
3. Selecting a revision updates the YAML inspector.
4. "Compare" mode allows selecting two revisions and viewing a diff.

### Diff view

- By default, show semantic diff of normalized JSON/YAML.
- Option to toggle to raw textual diff for exact YAML changes.
- Diff legend for add/remove/change with a summary count.

## Data sources

### Primary sources

- `jangar-db` is the source of truth for Agent specs and revisions.
- Audit log tables provide request metadata and actor context.

### Supporting data

- Provider bindings from the control plane to display resolved specs.
- Policy evaluations to explain rejections or guarded changes.

## API endpoints and queries

### Agent latest spec

`GET /v1/agents/{id}`

- Returns current Agent spec and metadata.
- Add fields:
  - `specYaml` (string)
  - `specJson` (object)
  - `revision` (int)
  - `resolvedSpecYaml` (string, optional)
  - `resolvedSpecJson` (object, optional)

### Revision list

`GET /v1/agents/{id}/revisions?limit=20&cursor=...`

- Returns a cursor-paginated list of revisions.
- Include minimal metadata for list performance:
  - `revision`
  - `createdAt`
  - `actorType`
  - `actorId`
  - `source`
  - `summary` (optional)

### Revision detail

`GET /v1/agents/{id}/revisions/{revision}`

- Returns full YAML/JSON snapshots and audit references.
- Response includes:
  - `specYaml`, `specJson`
  - `resolvedSpecYaml`, `resolvedSpecJson` (optional)
  - `auditEventId`
  - `policyChecks` (pass/fail summary)

### Diff endpoint (server-side)

`GET /v1/agents/{id}/revisions/diff?from=12&to=18&mode=semantic`

- Returns a structured diff payload.
- `mode=semantic` returns a JSON patch-like format.
- `mode=text` returns a unified diff string.

## Schema diffing approach

### Canonicalization

- Parse YAML to JSON and apply deterministic ordering.
- Remove ephemeral fields (timestamps, status) before diffing.
- Normalize arrays where order is not meaningful (policy-defined list).

### Semantic diff

- Generate a JSON Patch (RFC 6902) or similar op list.
- UI renders grouped changes by top-level path.
- Provide a short, human-readable summary string for each revision.

### Text diff

- Use a unified diff for exact YAML edits when ordering or formatting matters.
- Only compute text diff on request or in compare mode to save CPU.

## Performance and caching

### API caching

- Cache revision list and diff responses in the API layer (short TTL, e.g. 30-60s).
- Revalidate on new revision creation via cache bust signals.

### UI caching

- Store last-viewed revision in memory for quick back/forward.
- Use SWR-style stale-while-revalidate for the revision list.

### Payload sizing

- Keep revision list payloads small; fetch full YAML on selection.
- Provide gzip-compressed YAML for large specs.

### Diff computation

- Precompute semantic diffs between adjacent revisions on write.
- Cache computed diffs for arbitrary revision pairs on first request.

## Access control

- Respect existing RBAC at the control-plane API layer.
- Read-only access requires `agents:read`.
- Viewing audit metadata requires `audit:read`.
- Resolved specs may be filtered based on provider secrets policy.

## Rollout plan

1. Backend supports new endpoints and revision history storage.
2. UI feature flag for YAML inspector and timeline.
3. Internal dogfood rollout to admin users.
4. Gradual enablement by workspace or org.
5. Full rollout with documentation update.

## Telemetry

- Track feature usage:
  - YAML tab opened
  - revision selected
  - diff mode toggled
  - copy/download actions
- Track performance:
  - API latency for revision list and diff
  - payload size percentiles
- Log errors:
  - diff computation failures
  - YAML parse failures

## Open questions

- Should we store raw YAML only, or store both YAML and normalized JSON?
- Do we need a "compare with latest" quick action?
- Should rollback be supported directly from the timeline?
- How should we represent policy-rejected revisions in the UI?
