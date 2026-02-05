# Admission Control Policy for AgentRuns

Status: Draft (2026-02-04)

## Problem
Invalid or unsafe AgentRuns should be rejected early.

## Goals
- Provide policy hooks for validation.
- Surface clear rejection reasons.

## Non-Goals
- Implementing a full policy engine.

## Design
- Introduce policy checks for labels, secrets, and images.
- Allow policy config via values.

## Chart Changes
- Expose policy values and defaults.
- Document policy behavior.

## Controller Changes
- Validate AgentRun specs against policy before submit.

## Acceptance Criteria
- Unsafe runs are rejected with InvalidSpec.
- Valid runs proceed normally.
