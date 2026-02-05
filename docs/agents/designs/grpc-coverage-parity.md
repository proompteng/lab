# gRPC Coverage Parity for agentctl

Status: Draft (2026-02-05)

## Current State

- Code: gRPC server in services/jangar/src/server/agentctl-grpc.ts exposes a subset of kube-mode operations; watch streams are missing.
- Cluster: gRPC is enabled and exposed via agents-grpc service.
- CLI: agentctl can run in kube or gRPC mode; kube mode remains fuller coverage.


## Problem
gRPC endpoints lag behind REST and CLI features.

## Goals

- Ensure gRPC supports all CLI operations.
- Maintain compatibility with REST.

## Non-Goals

- Breaking changes to existing gRPC clients.

## Design

- Add missing gRPC methods and fields.
- Update agentctl to use new fields.

## Chart Changes

- Document gRPC enablement and tokens.

## Controller Changes

- Implement missing gRPC handlers.

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

- agentctl supports list/filter parity via gRPC.
- gRPC schema matches REST capabilities.
