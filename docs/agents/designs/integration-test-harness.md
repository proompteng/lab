# Integration Test Harness

Status: Draft (2026-02-05)

## Current State

- Scripts: scripts/agents/kind-e2e.sh, scripts/agents/native-workflow-e2e.sh, scripts/agents/validate-agents.sh.
- CI: agents-sync and validate workflows run helm lint and kustomize rendering.
- Cluster: no test harness resources deployed by default.


## Problem
High-scale changes need reliable integration testing.

## Goals

- Provide repeatable e2e harness for chart and controller.
- Support GitHub and Linear mocks.

## Non-Goals

- Full CI redesign.

## Design

- Expand scripts/agents/validate-agents.sh and smoke tests.
- Add deterministic fixtures.

## Chart Changes

- Add values-ci.yaml enhancements for test harness.

## Controller Changes

- Expose test hooks or flags when needed.

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

- CI runs reproducible integration tests.
- Failures provide actionable logs.
