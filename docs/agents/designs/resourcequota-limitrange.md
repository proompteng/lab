# ResourceQuota and LimitRange Integration

Status: Draft (2026-02-04)

## Problem
Clusters need quota enforcement for AgentRuns.

## Goals
- Expose optional ResourceQuota and LimitRange.
- Document required values for production.

## Non-Goals
- Dynamic quota management.

## Design
- Use values to define quota and limit range objects.
- Keep defaults disabled.

## Chart Changes
- Add ResourceQuota and LimitRange templates.

## Controller Changes
- None.

## Acceptance Criteria
- Resources render with correct values when enabled.
- Disabled by default.
