# GitOps and Argo CD Hooks

Status: Draft (2026-02-05)

## Current State

- Chart: argocdHooks templates support PreSync cleanup and PostSync smoke AgentRun.
- Cluster: argocd app values do not enable argocdHooks; no hook jobs present.
- Kustomize renders the chart with includeCRDs: true.


## Problem
GitOps deployments need deterministic pre/post-sync behavior.

## Goals

- Provide optional Argo CD hooks for smoke testing.
- Clean up smoke resources safely.

## Non-Goals

- Embedding GitOps controllers in the chart.

## Design

- Add optional PreSync and PostSync Jobs.
- Allow hook enablement via values.

## Chart Changes

- Add hook templates and values.
- Document Argo CD usage.

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

- Hooks run successfully when enabled.
- No hooks are created when disabled.
