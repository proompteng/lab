# Runner Image Defaults and Job TTL

Status: Draft (2026-02-04)

## Problem
Runs fail when workload image is missing or Jobs are cleaned up too early.

## Goals
- Provide a default runner image.
- Ensure Job TTL does not race status collection.

## Non-Goals
- Managing agent-runner image builds.

## Design
- Add chart-level runner image values and env wiring.
- Introduce safe TTL defaults with guardrails.

## Chart Changes
- Add runner.image.* values and schema.
- Document job TTL behavior.

## Controller Changes
- Validate runner image presence.
- Defer TTL until status recorded.

## Acceptance Criteria
- No MissingWorkloadImage failures when values set.
- Job status is captured before cleanup.
