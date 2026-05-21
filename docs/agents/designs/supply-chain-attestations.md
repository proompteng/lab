# Supply Chain Attestations

Status: Draft (2026-02-07)

Docs index: [README](../README.md)

## Current State

- Code: chart publishing supports optional Helm provenance generation through
  `packages/scripts/src/agents/publish-chart.ts` when `AGENTS_CHART_SIGN=true`.
- Code: Jangar image publishing enables BuildKit SBOM and max provenance attestations through
  `.github/workflows/jangar-build-push.yaml`.
- Cluster: not configured.

## Problem

Regulated environments require provenance attestations.

## Goals

- Produce build provenance metadata.
- Verify provenance before deployment.

## Non-Goals

- Replacing existing CI pipelines.

## Design

- Adopt SLSA-compatible attestations.
- Expose provenance verification steps.

## Chart Changes

- Document provenance requirements.

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

- BuildKit image attestations are published for each Jangar image release.
- Chart package provenance is published when signing credentials are configured.
- Documentation covers verification.
