# PR Rate Limits and Batching

Status: Draft (2026-02-04)

## Problem
VCS providers enforce rate limits that can throttle automation.

## Goals
- Batch PR creation and respect provider limits.
- Provide configurable rate limits.

## Non-Goals
- Circumventing provider rate limits.

## Design
- Add per-provider rate limiter with backoff.
- Expose limits via values.

## Chart Changes
- Document provider rate-limit settings.

## Controller Changes
- Apply limiter before PR actions.

## Acceptance Criteria
- Automation respects provider limits.
- Burst traffic is smoothed.
