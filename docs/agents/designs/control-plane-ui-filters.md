# Control Plane UI Filters

Status: Draft (2026-02-04)

## Problem
Operators cannot easily filter high-volume runs.

## Goals
- Provide label, phase, and runtime filters in UI.
- Avoid polling.

## Non-Goals
- Full analytics dashboard.

## Design
- Add filter inputs backed by API query params.
- Use SSE or watch streams for live updates.

## Chart Changes
- None.

## Controller Changes
- Support label selectors in API handlers.

## Acceptance Criteria
- UI filters affect list results immediately.
- No polling introduced.
