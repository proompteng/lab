# Codex Pipeline Observability Runbook

## Overview

The Codex implementation pipeline now has end-to-end telemetry for Kafka completions, NATS agent comms, and Jangar ingest/SSE health. All dashboards and alert rules live in the observability GitOps bundle.

## Grafana dashboard

- **Dashboard:** `Codex Pipeline Observability`
- **Location:** Grafana root folder (provisioned by `argocd/applications/observability/codex-pipeline-dashboard-configmap.yaml`).

### Panels

- **Kafka completions**
  - Ingest rate for `argo.workflows.completions` (messages/sec).
  - Consumer lag for `jangar-codex-completions`.
- **NATS agent comms**
  - Publish rate (`agent-comms` JetStream stream).
  - Stream size (messages + bytes).
  - Consumer lag for `jangar-agent-comms`.
- **Jangar ingest + SSE**
  - Agent comms DB insert rate.
  - Ingest error rate.
  - Active SSE connections (chat + agent-events).
  - SSE error rate.

## Alert thresholds

Alert rules are defined in `argocd/applications/observability/graf-mimir-rules.yaml` under `codex-pipeline-observability.rules`.

- **CodexKafkaCompletionsLagHigh**: `> 1000` messages lag for 15 minutes.
- **CodexNatsAgentCommsLagHigh**: `> 1000` pending JetStream messages for 15 minutes.
- **CodexJangarAgentCommsStalled**: JetStream stream advancing but zero inserts for 10 minutes.
- **CodexJangarSseErrorRate**: SSE errors exceed `0.05/sec` for 10 minutes.

## Data sources / scrape targets

- **Kafka**: `kafka-exporter` Deployment in `kafka` namespace (scraped by `kafka-alloy`).
- **NATS**: JetStream monitoring endpoint on port `8222` scraped by `nats-alloy`.
- **Jangar**: OTLP metrics exporter (OTEL) pushing to Mimir.

## Validation

1. Sync Argo CD apps:
   - `argocd app sync kafka`
   - `argocd app sync nats`
   - `argocd app sync observability`
   - `argocd app sync jangar`
2. In Grafana, open **Codex Pipeline Observability** and verify all panels are populated.
3. Simulate lag:
   - Pause the Jangar consumer or block inserts and confirm lag + stalled-ingest alerts fire after 10–15 minutes.
4. Simulate SSE errors:
   - Induce upstream failures (invalid request, disconnects) and verify error-rate panel moves.
