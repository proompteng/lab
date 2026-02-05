# API Pagination and Watch Behavior

Status: Draft (2026-02-05)

## Current State

- Code: /v1/agent-runs GET queries the database via getAgentRunsByAgent without pagination parameters.
- Code: control-plane SSE stream accepts a namespace param only and streams all primitive kinds.
- Cluster: no API pagination config or limits beyond internal defaults (limit 50 in store).


## Problem
Large lists can overload the API and clients.

## Goals

- Provide pagination for list endpoints.
- Support watch streams for incremental updates.

## Non-Goals

- Full query language.

## Design

- Add limit and continue token parameters.
- Expose watch streams with resource version.

## Chart Changes

- Document API pagination behavior.

## Controller Changes

- Implement pagination and watch options.

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

- Large lists return paginated results.
- Watch streams deliver incremental updates.
