# Schedule and CronJob Reliability

Status: Draft (2026-02-04)

## Problem
Schedule CRDs require reliable CronJob creation and cleanup.

## Goals
- Ensure CronJobs mirror Schedule specs.
- Handle updates and deletions safely.

## Non-Goals
- A full workflow scheduler.

## Design
- Generate CronJobs from Schedule resources.
- Use ownerReferences for cleanup.

## Chart Changes
- Document Schedule usage and required RBAC.

## Controller Changes
- Reconcile CronJobs for Schedule resources.

## Acceptance Criteria
- CronJobs are created and updated from Schedule.
- CronJobs are deleted when Schedule is removed.
