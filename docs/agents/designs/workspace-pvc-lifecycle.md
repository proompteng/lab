# Workspace PVC Lifecycle

Status: Draft (2026-02-05)

## Current State

- Code: supporting controller creates PVCs for Workspace CRs and enforces TTL expiry.
- Cluster: no Workspace resources present.


## Problem
Workspaces can leak storage without cleanup policies.

## Goals

- Provision PVCs for workspaces on demand.
- Auto-cleanup after retention.

## Non-Goals

- Persistent workspace snapshots.

## Design

- Support workspace size and storage class values.
- Implement cleanup on workspace deletion.

## Chart Changes

- Expose workspace defaults in values.

## Controller Changes

- Create and delete PVCs in supporting controller.

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

- PVCs created for workspace resources.
- PVCs deleted after workspace cleanup.
