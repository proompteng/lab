# Throughput Backpressure and Admission Control

Status: Draft (2026-02-04)

## Problem
High-volume runs can overwhelm controller and cluster resources.

## Goals
- Add backpressure with bounded queues.
- Protect per-namespace and per-repo fairness.

## Non-Goals
- Infinite buffering.

## Design
- Add admission checks for concurrency and queue depth.
- Expose queue and rate limits via values.

## Chart Changes
- Add controller.queue.* values.
- Document defaults and tuning.

## Controller Changes
- Reject or delay submissions when limits are exceeded.
- Expose metrics on queue depth.

## Acceptance Criteria
- Under load, controller maintains bounded latency.
- No resource exhaustion due to unbounded queues.
