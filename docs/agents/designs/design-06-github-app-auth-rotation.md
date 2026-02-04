# GitHub App Auth and Token Rotation

Status: Draft (2026-02-04)

## Problem
PATs do not scale well for high-volume PR automation.

## Goals
- Use GitHub App installation tokens with rotation.
- Cache and renew tokens safely.

## Non-Goals
- Supporting only PAT-based auth.

## Design
- Implement JWT flow to mint installation tokens.
- Cache tokens with pre-expiry renewal.

## Chart Changes
- Expose appId, installationId, and privateKey secret values.
- Provide examples for GitHub App auth.

## Controller Changes
- Add GitHub App token fetch/refresh logic.
- Use tokens for repo operations.

## Acceptance Criteria
- PR creation works without PATs.
- Tokens rotate without downtime.
