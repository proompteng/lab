# Network Policy Egress Control

Status: Draft (2026-02-07)
## Current State

- Chart: networkPolicy template supports ingress/egress lists; disabled by default.
- Cluster: a tailscale-specific NetworkPolicy exists via argocd/applications/agents, not chart values.
- Values: networkPolicy.enabled is false in argocd values.


## Problem
Autonomous agents require explicit egress controls for security.

## Goals

- Provide optional NetworkPolicy for egress.
- Allow configuring allowed destinations.

## Non-Goals

- Full service mesh integration.

## Design

- Expose egress rules in values.
- Default to disabled for portability.

## Chart Changes

- Add NetworkPolicy templates and schema entries.

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

- NetworkPolicy renders correctly when enabled.
- No policy created when disabled.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
