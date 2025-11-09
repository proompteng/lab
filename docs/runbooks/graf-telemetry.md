# Graf Telemetry Runbook

## Overview

- Graf now boots `GrafTelemetry` (OpenTelemetry) and ships traces/metrics/logs to the shared Tempo/Mimir/Loki stack in the `observability` namespace.
- The Knative service reads OTLP env vars from `argocd/applications/graf/knative-service.yaml` plus the `graf-otel-configmap`.
- The namespace also runs `graf-alloy` so JSON logs annotated with `trace_id`, `span_id`, and `request_id` appear in Loki.
- Dashboards and alerts live in `argocd/applications/observability/graf-graf-dashboard-configmap.yaml` and `graf-mimir-rules.yaml`, respectively.

## Deployment Steps

1. `argocd app sync graf` – updates the Knative service, the OTEL config map, and the `graf-alloy` deployment/ConfigMap/RBAC.
2. `argocd app sync observability` – ensures the Grafana dashboard config map, Mimir `PrometheusRule`, and any OTLP collectors are reconciled.
3. Optional: restart Graf pods by increasing the Knative revision annotation if payloads carry stale env vars.

## Validation Commands

- `kubectl -n graf get ksvc graf` – the Knative revision should be healthy and ready.
- `kubectl -n graf get deploy graf-alloy` – Alloy should have one replica ready.
- `kubectl -n graf logs deployment/graf-alloy` – watch for `POST /loki/api/v1/push` success messages.
- `kubectl -n graf logs ksvc/graf -c user-container | tail` – entries should be JSON with `trace_id`, `span_id`, `request_id`, and `job="graf"`.
- `kubectl -n observability get prometheusrule graf-telemetry-rules` – confirm the 3 rules exist and have `LastEvaluated`.
- Visit the Grafana dashboard titled “Graf Observability” (provisioned from `graf-graf-dashboard-configmap`) to see panels for request rate, Neo4j latency, Temporal workflow launches, and Loki log counts.
- Trigger a sample request via `curl http://$(kubectl -n graf get ksvc graf -o jsonpath='{.status.url}')/v1/entities` to generate telemetry.
- Check that the `GrafHigh5xxRate`, `GrafServiceDown`, and `GrafNoRequests` alerts are resolving/ok in Alertmanager.

## Troubleshooting

- If OTLP exporters fail, inspect `kubectl -n graf logs deployment/graf` for `Failed to export` or `context deadline exceeded` errors and verify OTLP env vars from `knative-service`.
- Alloy failing to ship logs? Check `kubectl -n graf describe configmap graf-alloy` and ensure the `loki.write` endpoint matches `observability-loki-loki-distributed-gateway`.
- Missing traces? Confirm `GrafTelemetry` spans appear by using `tempo` query for `/v1/entities` or `graf` service name.
- No metrics? Validate the Graf deployment exposes `/metrics` and that `up{job="graf"}` exists in Mimir.
