# Control Plane UI Filters

Status: Draft (2026-02-05)

## Current State

- Code: /api/agents/control-plane/stream supports namespace selection only; no server-side label/phase filters.
- Control-plane stream debounces status updates and emits all primitive kinds.
- Cluster: UI behavior is driven by SSE; no filter config in values.


## Problem
Operators cannot easily filter high-volume runs.

## Goals

- Provide label, phase, and runtime filters in UI.
- Avoid polling.

## Non-Goals

- Full analytics dashboard.

## Design

- Add filter inputs backed by API query params.
- Use SSE or watch streams for live updates.

## Chart Changes

- None.

## Controller Changes

- Support label selectors in API handlers.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.

## Validation

- Exercise the primary flow and confirm expected status, logs, or metrics.
- Confirm no regression in existing workflows, CI checks, or chart rendering.

## Acceptance Criteria

- UI filters affect list results immediately.
- No polling introduced.
