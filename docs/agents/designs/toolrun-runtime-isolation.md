# ToolRun Runtime Isolation

Status: Draft (2026-02-05)

## Current State

- Code: orchestration-controller submits ToolRun Jobs using tool.spec.image/command; isolation is limited to Kubernetes primitives.
- Cluster: no ToolRun resources present.


## Problem
Tool runs need consistent isolation and resource limits.

## Goals

- Support dedicated service accounts for ToolRuns.
- Allow per-tool resource policies.

## Non-Goals

- Building a new tool execution engine.

## Design

- Allow ToolRun workload overrides similar to AgentRun.
- Expose default tool workload settings.

## Chart Changes

- Add tool workload defaults to values.

## Controller Changes

- Apply tool workload defaults when submitting ToolRun jobs.

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

- ToolRun jobs honor resource limits.
- Dedicated service accounts are supported.
