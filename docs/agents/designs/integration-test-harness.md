# Integration Test Harness

Status: Draft (2026-02-04)

## Problem
High-scale changes need reliable integration testing.

## Goals
- Provide repeatable e2e harness for chart and controller.
- Support GitHub and Linear mocks.

## Non-Goals
- Full CI redesign.

## Design
- Expand scripts/agents/validate-agents.sh and smoke tests.
- Add deterministic fixtures.

## Chart Changes
- Add values-ci.yaml enhancements for test harness.

## Controller Changes
- Expose test hooks or flags when needed.

## Acceptance Criteria
- CI runs reproducible integration tests.
- Failures provide actionable logs.
