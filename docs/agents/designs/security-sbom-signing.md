# Security: SBOM and Signing

Status: Draft (2026-02-07)

Docs index: [README](../README.md)

- Code: `jangar-build-push` enables BuildKit SBOM and max provenance attestations for published Jangar images via
  `DOCKER_BUILD_SBOM=true` and `DOCKER_BUILD_PROVENANCE=max`.
- Chart: OCI chart publishing supports optional Helm provenance signing; image signature verification remains separate.
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

- SBOM and provenance attestations are published per Jangar image release.
- Signatures are verified in CI once registry signing credentials or keyless signing trust policy is configured.
