# Load Testing and Benchmarking

Status: Draft (2026-02-04)

## Problem
No standardized benchmark for 100-person throughput.

## Goals
- Define load test scenarios and metrics.
- Provide baseline performance numbers.

## Non-Goals
- Real-time performance optimization.

## Design
- Add load test script for AgentRun submission.
- Capture p95 and p99 latency metrics.

## Chart Changes
- Add values for test harness scale settings.

## Controller Changes
- Expose performance metrics for load tests.

## Acceptance Criteria
- Load test outputs standard metrics.
- Baseline numbers documented.
