# Signal Delivery Retries

Status: Draft (2026-02-07)
## Current State

- Code: SignalDelivery reconciliation marks Delivered immediately; no retry/backoff logic.
- Cluster: sample Signal exists; no SignalDelivery resources.


## Problem
SignalDelivery failures can leave workflows stuck.

## Goals

- Retry signal delivery with backoff.
- Track delivery attempts.

## Non-Goals

- Guaranteed exactly-once delivery.

## Design

- Add retry count and backoff to SignalDelivery status.
- Expose configuration via values.

## Chart Changes

- Document signal retry settings.

## Controller Changes

- Retry failed deliveries and update status.

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

- Failed deliveries retry and eventually succeed or fail terminally.
- Status includes attempt metadata.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
