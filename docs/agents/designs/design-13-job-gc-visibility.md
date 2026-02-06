# Job GC Visibility and Retention

Status: Draft (2026-02-04)

## Problem
Jobs may be deleted before status is collected, causing WorkflowJobMissing.

## Goals
- Make Job lifecycle visible and configurable.
- Avoid premature cleanup.

## Non-Goals
- Persisting full job logs in the controller.

## Design
- Expose job TTL values and retention policies.
- Add warnings when job is missing unexpectedly.

## Chart Changes
- Add jobTTLSeconds and log retention values.

## Controller Changes
- Delay status reconciliation until job is confirmed created.

## Acceptance Criteria
- WorkflowJobMissing is rare and observable.
- Operators can adjust TTL safely.
