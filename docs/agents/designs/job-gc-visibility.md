# Job GC Visibility and Retention

Status: Draft (2026-02-07)
## Current State

- Code: AgentRun retention via ttlSecondsAfterFinished or JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS; Job TTL via JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS; ToolRun TTL supported.
- Chart: controller.jobTtlSecondsAfterFinished available with default 600s.
- Cluster: retention env is set (~30d); job TTL env set to 600 seconds.


## Problem
Jobs may be deleted before status is collected, causing WorkflowJobMissing.

## Goals

- Make Job lifecycle visible and configurable.
- Avoid premature cleanup.

## Non-Goals

- Persisting full job logs in the controller.

## Design

- Expose job TTL values and retention policies.
- Add warnings when job is missing unexpectedly.

## Chart Changes

- Add jobTTLSeconds and log retention values.

## Controller Changes

- Delay status reconciliation until job is confirmed created.

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

- WorkflowJobMissing is rare and observable.
- Operators can adjust TTL safely.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
