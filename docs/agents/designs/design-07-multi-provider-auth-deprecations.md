# Multi-Provider Auth Standards and Deprecations

Status: Draft (2026-02-04)

## Problem
Provider auth modes differ and deprecations cause silent failures.

## Goals
- Normalize auth fields across providers.
- Detect deprecated auth types early.

## Non-Goals
- Implementing all provider features.

## Design
- Define provider-specific auth adapters.
- Add warnings for deprecated token types.

## Chart Changes
- Expose auth options in values examples.
- Document token scopes and expiry guidance.

## Controller Changes
- Validate auth config by provider.
- Surface warnings in status conditions.

## Acceptance Criteria
- Provider misconfigurations are rejected with clear errors.
- Deprecations emit warnings before failures.
