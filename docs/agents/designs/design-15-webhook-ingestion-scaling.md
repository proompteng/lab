# Webhook Ingestion Scaling

Status: Draft (2026-02-04)

## Problem
Webhook bursts can overload reconciliation.

## Goals
- Buffer and process webhooks safely.
- Apply backoff on provider failures.

## Non-Goals
- Polling-based ingestion.

## Design
- Queue webhook events with bounded buffers.
- Deduplicate webhook events by idempotency keys.

## Chart Changes
- Expose webhook queue size and retry settings.

## Controller Changes
- Persist last webhook sync metadata.
- Use exponential backoff on failures.

## Acceptance Criteria
- Webhook bursts do not drop events.
- Backoff does not block other reconciliation.
