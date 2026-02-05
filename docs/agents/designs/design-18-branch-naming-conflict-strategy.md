# Branch Naming and Conflict Strategy

Status: Draft (2026-02-04)

## Problem
Concurrent PRs can clash on branch names.

## Goals
- Provide deterministic branch naming templates.
- Handle conflicts by auto-suffixing.

## Non-Goals
- Full git merge conflict resolution.

## Design
- Add branchTemplate and conflict suffix policy.
- Document naming in VersionControlProvider defaults.

## Chart Changes
- Expose defaults via values or examples.

## Controller Changes
- Apply naming templates to run metadata.

## Acceptance Criteria
- Branch names are deterministic and unique.
- Conflicts resolve by suffixing.
