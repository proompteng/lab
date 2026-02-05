# Staging and Production Values Overlays

Status: Draft (2026-02-05)

## Current State

- Chart: values-dev.yaml, values-prod.yaml, values-ci.yaml, values-local.yaml, values-kind.yaml exist.
- GitOps: argocd/applications/agents/values.yaml is the in-cluster overlay.
- Cluster: the agents ArgoCD app currently applies only the in-repo values overlay.


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

- Environment overlays render without warnings.
- Docs include guidance for overrides.
