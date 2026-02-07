# Schedule and CronJob Reliability

Status: Draft (2026-02-07)
## Current State

- Code: supporting controller materializes Schedule CRs as CronJobs and watches CronJob status.
- Chart: runtime.scheduleRunnerImage and runtime.scheduleServiceAccount map to JANGAR_SCHEDULE_* envs.
- Cluster: no Schedule resources present.


## Problem
Schedule CRDs require reliable CronJob creation and cleanup.

## Goals

- Ensure CronJobs mirror Schedule specs.
- Handle updates and deletions safely.

## Non-Goals

- A full workflow scheduler.

## Design

- Generate CronJobs from Schedule resources.
- Use ownerReferences for cleanup.

## Chart Changes

- Document Schedule usage and required RBAC.

## Controller Changes

- Reconcile CronJobs for Schedule resources.

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

- CronJobs are created and updated from Schedule.
- CronJobs are deleted when Schedule is removed.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
