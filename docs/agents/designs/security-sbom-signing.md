# Security: SBOM and Signing

Status: Draft (2026-02-07)
## Current State

- Code: no SBOM generation or signing pipeline in repo workflows.
- Chart: no values for SBOM or signing.
- Cluster: no admission policy or runtime verification is configured for signed images.


## Problem
Supply chain integrity is required for production adoption.

## Goals

- Publish SBOMs for Jangar images.
- Verify image signatures in CI.

## Non-Goals

- Replacing existing build systems.

## Design

- Generate SBOMs during build.
- Use cosign or equivalent to sign images.

## Chart Changes

- Document image signing and verification.

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

- SBOM artifacts are published per release.
- Signatures are verified in CI.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
