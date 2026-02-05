# Metrics and OpenTelemetry Tracing

Status: Draft (2026-02-04)

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

## Acceptance Criteria
- Traces span submission to job completion.
- Metrics include runtime labels.
