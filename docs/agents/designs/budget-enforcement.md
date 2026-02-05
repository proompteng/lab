# Budget Enforcement

Status: Draft (2026-02-05)

## Current State

- Code: validateBudget enforces Budget limits in orchestration-submit and /v1/agent-runs when budgetRef is supplied.
- Budgets are reconciled by supporting-primitives-controller (status + Ready conditions).
- Cluster: sample-budget exists; enforcement only applies when referenced.


## Problem
Runs can exceed token or cost budgets without enforcement.

## Goals

- Enforce budget constraints per run.
- Surface budget exhaustion in status.

## Non-Goals

- Real-time billing integrations.

## Design

- Validate budget settings before submission.
- Reject runs that exceed budget.

## Chart Changes

- Document Budget CRD usage.

## Controller Changes

- Check Budget resources during submission.

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

- Budget violations block submission.
- Status shows budget failure reason.
