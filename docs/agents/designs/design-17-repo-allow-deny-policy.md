# Repository Allow and Deny Policy

Status: Draft (2026-02-04)

## Problem
Repository access must be constrained for security.

## Goals
- Allowlist or denylist repository patterns.
- Expose policy in VersionControlProvider.

## Non-Goals
- Dynamic policy updates from external services.

## Design
- Support allow/deny patterns with wildcard matching.
- Block runs when repo is not allowed.

## Chart Changes
- Document repository policy usage.

## Controller Changes
- Enforce policy during VCS resolution.

## Acceptance Criteria
- Denied repos are blocked with clear errors.
- Allowed repos proceed.
