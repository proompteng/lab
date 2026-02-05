# Staging and Production Values Overlays

Status: Draft (2026-02-04)

## Problem
Operators need consistent overlays for staging and prod.

## Goals
- Provide baseline values files for environments.
- Document differences clearly.

## Non-Goals
- Automatic environment detection.

## Design
- Maintain values-dev.yaml, values-ci.yaml, values-prod.yaml.
- Ensure schema coverage for all values.

## Chart Changes
- Review values files for completeness and alignment.

## Controller Changes
- None.

## Acceptance Criteria
- Environment overlays render without warnings.
- Docs include guidance for overrides.
