# Network Policy Egress Control

Status: Draft (2026-02-04)

## Problem
Autonomous agents require explicit egress controls for security.

## Goals
- Provide optional NetworkPolicy for egress.
- Allow configuring allowed destinations.

## Non-Goals
- Full service mesh integration.

## Design
- Expose egress rules in values.
- Default to disabled for portability.

## Chart Changes
- Add NetworkPolicy templates and schema entries.

## Controller Changes
- None.

## Acceptance Criteria
- NetworkPolicy renders correctly when enabled.
- No policy created when disabled.
