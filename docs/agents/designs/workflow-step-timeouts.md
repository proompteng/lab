# Workflow Step Timeouts and Retries

Status: Draft (2026-02-05)

## Current State

- Code: orchestration-controller supports retries/backoff per step but no explicit timeout fields.
- Chart: no timeout values.
- Cluster: no deployment env vars or values configure workflow step timeouts.


## Problem
Long-running steps can block workflows without clear timeout handling.

## Goals

- Add per-step timeout configuration.
- Standardize retry behavior.

## Non-Goals

- Implementing a new workflow engine.

## Design

- Add timeout fields to workflow step spec.
- Enforce timeout in controller and mark step failed.

## Chart Changes

- Update CRD schema and examples.

## Controller Changes

- Track step start times and enforce deadlines.

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

- Steps time out deterministically.
- Retries respect backoff settings.
