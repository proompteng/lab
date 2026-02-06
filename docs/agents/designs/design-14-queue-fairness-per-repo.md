# Queue Fairness per Repository

Status: Draft (2026-02-04)

## Problem
High-volume repos can starve smaller repos of capacity.

## Goals
- Enforce per-repo concurrency limits.
- Provide fair scheduling.

## Non-Goals
- Advanced priority scheduling.

## Design
- Key runs by repository in the queue.
- Enforce per-repo limits with configurable caps.

## Chart Changes
- Add controller.repoConcurrency.* values.

## Controller Changes
- Track and enforce per-repo in-flight limits.

## Acceptance Criteria
- No single repo can exceed configured concurrency.
- Other repos continue processing.
