# Topology Spread Defaults

Status: Draft (2026-02-07)
## Current State

- Code: agents-controller applies topologySpreadConstraints from runtime config or JANGAR_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS.
- Chart: controller.defaultWorkload.topologySpreadConstraints maps to env.
- Cluster: defaultWorkload not set.


## Problem
Workloads can stack on a single node without spread rules.

## Goals

- Expose topology spread constraints at chart level.
- Allow AgentRun overrides.

## Non-Goals

- Scheduling across clusters.

## Design

- Add defaultWorkload.topologySpreadConstraints in values.
- Use controller env to pass JSON arrays.

## Chart Changes

- Add values and schema entries.
- Document usage in README.

## Controller Changes

- Parse env JSON and apply to Job pod spec.

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

- Jobs spread across nodes when configured.
- Invalid JSON is ignored with warnings.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
