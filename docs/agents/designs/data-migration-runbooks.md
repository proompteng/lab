# Data Migration Runbooks

Status: Draft (2026-02-05)

## Current State

- Code: migrations live under services/jangar/src/server/migrations; no dedicated runbooks in docs/agents.
- Chart: no migration job; JANGAR_MIGRATIONS=auto in the deployment.
- Cluster: migrations run on startup (auto).


## Problem
Upgrades require clear migration instructions.

## Goals

- Provide step-by-step runbooks for schema changes.
- Reduce upgrade risk.

## Non-Goals

- Automatic migration tooling.

## Design

- Add versioned migration runbooks in docs.
- Include validation and rollback steps.

## Chart Changes

- Link runbooks in README.

## Controller Changes

- Expose migration status flags.

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

- Runbooks exist for each breaking change.
- Operators can roll back safely.
