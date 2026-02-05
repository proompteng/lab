# Metrics and OpenTelemetry Tracing

Status: Draft (2026-02-05)

## Current State

- Code: OTEL metrics export is implemented in services/jangar/src/server/metrics.ts (OTLP HTTP exporter).
- Tracing: no OpenTelemetry tracing setup found in services/jangar.
- Cluster: no OTEL env variables set for the agents deployment.


## Problem
Without tracing, it is hard to debug end-to-end latency.

## Goals

- Add trace propagation across controller and agent-runner.
- Expose standard metrics.

## Non-Goals

- Building a custom tracing backend.

## Design

- Adopt OpenTelemetry exporters and context propagation.
- Expose metrics for reconcile and runtime steps.

## Chart Changes

- Add otel config values and env wiring.

## Controller Changes

- Instrument reconciles and API handlers.

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

- Traces span submission to job completion.
- Metrics include runtime labels.
