# Scheduler Affinity and Priority Defaults

Status: Draft (2026-02-04)

## Problem
Large clusters need consistent workload placement rules.

## Goals
- Expose default node selectors, affinity, and priority classes.
- Provide safe defaults.

## Non-Goals
- Advanced scheduling controllers.

## Design
- Use controller defaultWorkload values for job pods.
- Allow per-run overrides.

## Chart Changes
- Expose defaultWorkload fields in values and schema.

## Controller Changes
- Apply defaults to Job pod spec when not overridden.

## Acceptance Criteria
- Job pods inherit default scheduling policies.
- Per-run overrides take precedence.
