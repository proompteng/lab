# Log Retention and Shipping

Status: Draft (2026-02-05)

## Current State

- Code: no log shipping or retention management in Jangar services.
- Cluster: no log shipper sidecar is configured for the agents deployment.


## Problem
Job logs are ephemeral and hard to retrieve after completion.

## Goals

- Persist logs for a configurable retention window.
- Provide optional shipping to external stores.

## Non-Goals

- Implementing a custom log backend.

## Design

- Capture logs as artifacts and store in object storage.
- Expose retention configuration.

## Chart Changes

- Add values for log storage endpoints and retention.

## Controller Changes

- Emit artifact metadata for logs.

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

- Logs are retrievable after job completion.
- Retention policy is enforced.
