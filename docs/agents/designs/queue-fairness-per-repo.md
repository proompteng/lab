# Queue Fairness per Repository

Status: Draft (2026-02-05)

## Current State

- Code: `/v1/agent-runs` admission enforces queue caps per namespace/cluster/repo and returns 429 when exceeded. It
  does not enforce per-repo in-flight concurrency or fairness in scheduling.
- Controller reconciliation enforces queue limits for direct AgentRun CRs; per-agent concurrency remains the only
  fairness control on that path.
- Chart: `controller.queue.*` values map to `JANGAR_AGENTS_CONTROLLER_QUEUE_*` envs used by the API admission path.
- Cluster: queue env vars are set (200/50/1000), so API admission uses explicit caps today.

## Problem
High-volume repos can starve smaller repos of capacity.

## Goals

- Enforce per-repo concurrency limits.
- Provide fair scheduling.

## Non-Goals

- Advanced priority scheduling.

## Design

- Keep per-repo queue caps in API admission as a guardrail against bursty repos.
- Add per-repo in-flight tracking in the controller so a single repo cannot monopolize runtime submission.
- When multiple repos are queued, select the next run via round-robin or weighted fairness to avoid starvation.

## Chart Changes

- Add `controller.concurrency.perRepo` (or similar) to cap per-repo in-flight submissions.
- Add an optional fairness mode/weighting value to select round-robin vs weighted scheduling.

## Controller Changes

- Track per-repo in-flight submissions and apply caps before runtime submission.
- Implement fair selection of pending runs across repos when multiple are eligible.

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

- No single repo can exceed configured concurrency.
- Other repos continue processing.
