# Controller Concurrency Tuning

Status: Draft (2026-02-05)

## Current State

- Code: agents-controller enforces per-agent/per-namespace/cluster concurrency; `/v1/agent-runs` admission checks
  namespace/cluster concurrency plus queue/rate limits for API submissions.
- Chart: controller.concurrency values map to JANGAR_AGENTS_CONTROLLER_CONCURRENCY_* envs.
- Cluster: envs are set to 10/5/100 in the agents deployment.


## Problem
Default concurrency limits may not fit large clusters.

## Goals

- Expose tuning knobs for reconcile concurrency.
- Provide metrics for saturation.

## Non-Goals

- Automatic autoscaling of controller replicas.

## Design

- Add metrics for in-flight counts.
- Document tuning guidance.

## Chart Changes

- Ensure all concurrency values are in schema and README.

## Controller Changes

- Expose in-flight counts and throttle metrics.

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

- Operators can tune concurrency safely.
- Metrics indicate saturation.
