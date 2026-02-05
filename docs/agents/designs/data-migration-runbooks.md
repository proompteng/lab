# Data Migration Runbooks

Status: Draft (2026-02-04)

## Problem
Upgrades require clear migration instructions.

## Goals
- Provide step-by-step runbooks for schema changes.
- Reduce upgrade risk.

## Non-Goals
- Automatic migration tooling.

## Design
- Add versioned migration runbooks in docs.
- Include validation and rollback steps.

## Chart Changes
- Link runbooks in README.

## Controller Changes
- Expose migration status flags.

## Acceptance Criteria
- Runbooks exist for each breaking change.
- Operators can roll back safely.
