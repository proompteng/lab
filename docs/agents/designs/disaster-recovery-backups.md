# Disaster Recovery and Backups

Status: Draft (2026-02-07)
## Current State

- Code: no backup/restore automation in Jangar services.
- Chart: no backup jobs or hooks.
- Cluster: no backup Jobs or CronJobs are present in the agents namespace; backups are external to this chart.


## Problem
State loss can halt autonomous operations.

## Goals

- Provide backup and restore guidance.
- Define recovery objectives.

## Non-Goals

- Bundling a backup system.

## Design

- Document backup strategy for database and CRDs.
- Provide restore validation steps.

## Chart Changes

- Reference backup recommendations in README.

## Controller Changes

- Expose health endpoints for backup readiness.

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

- Backup and restore steps are documented.
- Recovery tests are defined.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
