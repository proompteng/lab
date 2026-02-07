# Cluster Cost Optimization

Status: Draft (2026-02-07)
## Current State

- Code: no explicit cost-optimization logic beyond concurrency limits and resource requests.
- Chart: autoscaling is disabled in argocd values (replicaCount=1, autoscaling.enabled=false).
- Cluster: no ResourceQuota or LimitRange in the agents namespace.


## Problem
High throughput can lead to wasted compute costs.

## Goals

- Optimize resource requests and scaling defaults.
- Provide guidance on cost controls.

## Non-Goals

- Full cost management system.

## Design

- Document resource sizing profiles.
- Expose autoscaling and right-sizing controls.

## Chart Changes

- Add sizing profiles in values and README.

## Controller Changes

- Expose metrics for resource utilization.

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

- Operators can select sizing profiles.
- Cost guidance is documented.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
