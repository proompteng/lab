# Audit Logging for Autonomous Actions

Status: Draft (2026-02-05)

## Current State

- Code: audit_events table + createAuditEvent in primitives-store; used by orchestration-submit and /v1/agent-runs policy decisions.
- Chart: no audit sink configuration beyond the primary Jangar database.
- Cluster: no dedicated audit pipeline configured.


## Problem
High scale PR automation needs traceable audit logs.

## Goals

- Emit audit logs for run submissions and PR actions.
- Include correlation ids and repo context.

## Non-Goals

- A full SIEM integration.

## Design

- Structured logs with consistent fields.
- Optional audit log sink configuration.

## Chart Changes

- Expose audit log settings in values.

## Controller Changes

- Emit audit events on key actions.

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

- Audit logs include agentRun uid and repo.
- Audit sink can be enabled by values.
