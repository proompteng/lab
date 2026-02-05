# agentctl CLI Resilience

Status: Draft (2026-02-05)

## Current State

- Code: agentctl lives in services/jangar/agentctl; no retry/backoff logic is implemented in the CLI.
- Transport: gRPC server in services/jangar/src/server/agentctl-grpc.ts is enabled in the agents deployment.
- Cluster: gRPC service agents-grpc exists; kube mode remains the most complete interface.


## Problem
CLI failures reduce operator trust and automation reliability.

## Goals

- Improve CLI error messages and retries.
- Support offline diagnostics.

## Non-Goals

- Replacing the CLI with a UI.

## Design

- Add structured error output and retry options.
- Provide diagnose subcommand enhancements.

## Chart Changes

- Document CLI settings in README.

## Controller Changes

- Expose detailed status for CLI consumption.

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

- CLI failures include actionable guidance.
- Diagnose output includes controller health.
