# Implementation Contract Enforcement

Status: Draft (2026-02-05)

## Current State

- Code: validateImplementationContract enforces required metadata keys on AgentRuns and workflow steps.
- Failures set AgentRun status InvalidSpec with MissingRequiredMetadata.
- Chart: no values; enforcement is controller-driven.
- Cluster: enforcement is always on in the agents deployment; no feature flag disables it.


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

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.

## Validation

- Exercise the primary flow and confirm expected status, logs, or metrics.
- Confirm no regression in existing workflows, CI checks, or chart rendering.

## Acceptance Criteria

- Runs fail fast with clear missing keys.
- Valid runs proceed.
