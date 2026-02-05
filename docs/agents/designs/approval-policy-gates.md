# Approval Policy Gates

Status: Draft (2026-02-05)

## Current State

- Code: validatePolicies checks ApprovalPolicy state in orchestration-submit and /v1/agent-runs; direct AgentRun CRs bypass it.
- CRD: approvalpolicies.approvals.proompteng.ai is installed via the chart.
- Cluster: sample-approval-policy exists but is only enforced when referenced.


## Problem
High-risk runs should require approval before execution.

## Goals

- Support approval gates in workflows.
- Allow multiple approval providers.

## Non-Goals

- Implementing a full approval UI.

## Design

- Add ApprovalPolicy checks in orchestration steps.
- Expose approval events via SignalDelivery.

## Chart Changes

- Document approval policies and signals.

## Controller Changes

- Pause workflows until approval is received.

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

- Runs pause on approval gates.
- Approval resumes execution.
