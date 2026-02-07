# SecretBinding Guardrails

Status: Draft (2026-02-07)
## Current State

- Code: supporting controller validates SecretBindings; agents-controller and /v1/agent-runs enforce allowlists.
- API: /v1/agent-runs requires secretBindingRef when secrets are requested.
- Cluster: codex-github-token SecretBinding exists.


## Problem
Runs can mount secrets without clear governance.

## Goals

- Enforce secret allowlists and bindings.
- Surface violations in status.

## Non-Goals

- Secret rotation automation.

## Design

- Use SecretBinding CRDs to govern which secrets may be used.
- Validate bindings before job creation.

## Chart Changes

- Add examples for SecretBinding usage.

## Controller Changes

- Check SecretBinding before mounting secrets.

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

- Unauthorized secrets are rejected.
- Authorized secrets are allowed.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
