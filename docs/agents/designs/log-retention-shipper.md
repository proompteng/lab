# Log Retention and Shipping

Status: Draft (2026-02-04)

## Problem
Job logs are ephemeral and hard to retrieve after completion.

## Goals
- Persist logs for a configurable retention window.
- Provide optional shipping to external stores.

## Non-Goals
- Implementing a custom log backend.

## Design
- Capture logs as artifacts and store in object storage.
- Expose retention configuration.

## Chart Changes
- Add values for log storage endpoints and retention.

## Controller Changes
- Emit artifact metadata for logs.

## Acceptance Criteria
- Logs are retrievable after job completion.
- Retention policy is enforced.
