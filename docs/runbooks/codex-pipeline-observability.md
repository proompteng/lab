# Codex Pipeline Observability Runbook

## Overview

The Codex implementation pipeline now has end-to-end telemetry for NATS agent comms and Jangar ingest/SSE health. Agents-native AgentRun state, logs, and artifacts are observed through the Agents service; the legacy Argo Workflow completion Kafka path is no longer active runtime.

## Grafana dashboard

- **Dashboard:** `Codex Pipeline Observability`
- **Location:** Grafana root folder (provisioned by `argocd/applications/observability/codex-pipeline-dashboard-configmap.yaml`).

### Panels

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

- **CodexNatsAgentCommsLagHigh**: `> 1000` pending JetStream messages for 15 minutes.
- **CodexJangarAgentCommsStalled**: JetStream stream advancing but zero inserts for 10 minutes.
- **CodexJangarSseErrorRate**: SSE errors exceed `0.05/sec` for 10 minutes.

## Data sources / scrape targets

- **NATS**: `nats-prometheus-exporter` with JetStream `-jsz=streams,consumers` (scraped by `nats-alloy`).
- **Jangar**: OTLP metrics exporter (OTEL) pushing to Mimir.

## Validation

1. Sync Argo CD apps:
   - `argocd app sync nats`
   - `argocd app sync observability`
   - `argocd app sync jangar`
2. In Grafana, open **Codex Pipeline Observability** and verify all panels are populated.
3. Simulate lag:
   - Pause the Jangar agent-comms consumer or block inserts and confirm lag + stalled-ingest alerts fire after 10–15 minutes.
4. Simulate SSE errors:
   - Induce upstream failures (invalid request, disconnects) and verify error-rate panel moves.
