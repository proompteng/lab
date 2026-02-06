# Implementation Contract Enforcement

Status: Draft (2026-02-04)

## Problem
Runs can fail if required metadata is missing.

## Goals
- Enforce implementation contract before runtime submit.
- Expose required keys in status.

## Non-Goals
- Auto-filling metadata from external sources beyond configured mappings.

## Design
- Validate contract.requiredKeys and mappings.
- Surface missing keys as InvalidSpec.

## Chart Changes
- Update examples to include contract usage.

## Controller Changes
- Add contract validation before submission.

## Acceptance Criteria
- Runs fail fast with clear missing keys.
- Valid runs proceed.
