# Observability Pack

Status: Draft (2026-02-04)

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

## Acceptance Criteria
- Prometheus can scrape metrics with minimal config.
- Dashboards load with standard labels.
