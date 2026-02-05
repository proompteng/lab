# Budget Enforcement

Status: Draft (2026-02-04)

## Problem
Runs can exceed token or cost budgets without enforcement.

## Goals
- Enforce budget constraints per run.
- Surface budget exhaustion in status.

## Non-Goals
- Real-time billing integrations.

## Design
- Validate budget settings before submission.
- Reject runs that exceed budget.

## Chart Changes
- Document Budget CRD usage.

## Controller Changes
- Check Budget resources during submission.

## Acceptance Criteria
- Budget violations block submission.
- Status shows budget failure reason.
