# Artifact Storage Integration

Status: Draft (2026-02-07)
## Current State

- Code: codex-judge fetches artifacts from S3 using JANGAR_CODEX_ARTIFACT_BUCKET/ARTIFACT_BUCKET.
- Artifact CRD reconciliation only sets a status URI and does not provision storage backends.
- Cluster: agents deployment does not set artifact bucket envs.


## Problem
Artifacts need durable storage at scale.

## Goals

- Provide S3-compatible artifact storage support.
- Expose credentials via secrets.

## Non-Goals

- Bundling object storage in the chart.

## Design

- Add artifact storage config and secret refs.
- Ensure agent-runner writes artifacts to storage.

## Chart Changes

- Expose artifact storage values and schema.

## Controller Changes

- Pass artifact config to jobs via env.

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

- Artifacts persist outside the cluster.
- Credentials are secret-based.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
