# Observability Pack

Status: Draft (2026-02-07)
## Current State

- Code: OTEL metrics export exists; SSE metrics and queue depth histograms are recorded.
- Chart: no ServiceMonitor/dashboard templates; no metrics values in charts/agents.
- Cluster: no OTEL env variables set; no Prometheus scrape config in chart.


## Problem
Operators need metrics, logs, and dashboards to run at scale.

## Goals

- Expose Prometheus metrics and standard dashboards.
- Provide structured logs and trace IDs.

## Non-Goals

- Building a custom observability stack.

## Design

- Expose metrics endpoint and optional ServiceMonitor.
- Ship Grafana dashboard ConfigMaps.

## Chart Changes

- Add metrics.service and serviceMonitor values.
- Add dashboard ConfigMap templates.

## Controller Changes

- Emit metrics for reconcile latency and run outcomes.

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

- Prometheus can scrape metrics with minimal config.
- Dashboards load with standard labels.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
