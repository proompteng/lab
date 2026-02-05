# Webhook Ingestion Scaling

Status: Draft (2026-02-05)

## Current State

- Code: implementation-source-webhooks handles GitHub/Linear webhooks, validates secrets, and writes ImplementationSpecs; no queueing layer.
- Cluster: github-lab and github-lab-env ImplementationSources are Ready.
- Chart: no scaling-specific knobs beyond controller.namespaces and deployment replicas.


## Problem
Webhook bursts can overload reconciliation.

## Goals

- Buffer and process webhooks safely.
- Apply backoff on provider failures.

## Non-Goals

- Polling-based ingestion.

## Design

- Queue webhook events with bounded buffers.
- Deduplicate webhook events by idempotency keys.

## Chart Changes

- Expose webhook queue size and retry settings.

## Controller Changes

- Persist last webhook sync metadata.
- Use exponential backoff on failures.

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

- Webhook bursts do not drop events.
- Backoff does not block other reconciliation.
