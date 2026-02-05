# Controller Concurrency Tuning

Status: Draft (2026-02-04)

## Problem
Default concurrency limits may not fit large clusters.

## Goals
- Expose tuning knobs for reconcile concurrency.
- Provide metrics for saturation.

## Non-Goals
- Automatic autoscaling of controller replicas.

## Design
- Add metrics for in-flight counts.
- Document tuning guidance.

## Chart Changes
- Ensure all concurrency values are in schema and README.

## Controller Changes
- Expose in-flight counts and throttle metrics.

## Acceptance Criteria
- Operators can tune concurrency safely.
- Metrics indicate saturation.
