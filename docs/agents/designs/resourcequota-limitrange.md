# ResourceQuota and LimitRange Integration

Status: Draft (2026-02-05)

## Current State

- Chart: resourceQuota and limitRange templates exist and are disabled by default.
- Cluster: no ResourceQuota or LimitRange in the agents namespace.


## Problem
Clusters need quota enforcement for AgentRuns.

## Goals

- Expose optional ResourceQuota and LimitRange.
- Document required values for production.

## Non-Goals

- Dynamic quota management.

## Design

- Use values to define quota and limit range objects.
- Keep defaults disabled.

## Chart Changes

- Add ResourceQuota and LimitRange templates.

## Controller Changes

- None.

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

- Resources render with correct values when enabled.
- Disabled by default.
