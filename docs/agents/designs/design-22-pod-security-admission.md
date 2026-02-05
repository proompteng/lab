# Pod Security Admission Labels

Status: Draft (2026-02-04)

## Problem
Namespaces need PSA labels for enforcement.

## Goals
- Allow optional PSA labels on the namespace.
- Support opt-in enforcement.

## Non-Goals
- Managing PodSecurityPolicies.

## Design
- Add values for PSA labels and optional namespace creation.
- Document compatibility with existing namespaces.

## Chart Changes
- Add namespace label template gated by values.

## Controller Changes
- None.

## Acceptance Criteria
- Namespace labels are applied when enabled.
- No changes when disabled.
