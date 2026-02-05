# Signal Delivery Retries

Status: Draft (2026-02-04)

## Problem
SignalDelivery failures can leave workflows stuck.

## Goals
- Retry signal delivery with backoff.
- Track delivery attempts.

## Non-Goals
- Guaranteed exactly-once delivery.

## Design
- Add retry count and backoff to SignalDelivery status.
- Expose configuration via values.

## Chart Changes
- Document signal retry settings.

## Controller Changes
- Retry failed deliveries and update status.

## Acceptance Criteria
- Failed deliveries retry and eventually succeed or fail terminally.
- Status includes attempt metadata.
