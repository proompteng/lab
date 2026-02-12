# Torghut Quant Control Plane Runbook

## Overview

Use this runbook for alerts tied to the Jangar quant control-plane (near-real-time strategy performance) and its
upstream Torghut trading signals. This covers data freshness, decision activity, execution quality proxies, and
control-plane stream health.

## Alert thresholds

Alert rules are defined in `argocd/applications/observability/graf-mimir-rules.yaml` under
`torghut-quant-control-plane.rules`.

- **TorghutQuantDecisionsStalledDuringMarketHours**: No trading decisions for 15 minutes during market hours.
- **TorghutQuantOrderRejectionRateHigh**: Rejected orders >20% of submitted orders for 10 minutes.
- **TorghutQuantLLMErrorRateHigh**: Trading LLM errors >10% of requests for 10 minutes.
- **JangarQuantControlPlaneStreamErrors**: Control-plane SSE errors >0.05/sec for 10 minutes.
- **JangarTorghutQuantFramesMissingDuringMarketHours**: No computed `1d` frames for 5 minutes during market hours.
- **JangarTorghutQuantComputeErrors**: Quant compute loop errors >0 for 10 minutes.
- **JangarTorghutQuantStaleFramesDuringMarketHours**: Stale `1d` frames observed for 10 minutes during market hours.

## Triage checklist

1. Confirm control-plane API health.
   - `kubectl -n agents port-forward svc/agents 8080:80`
   - `curl -fsS "http://127.0.0.1:8080/api/agents/control-plane/status?namespace=agents" | jq .`
2. Confirm Torghut trading pipeline is running.
   - `kubectl -n torghut get ksvc torghut`
   - `kubectl -n torghut port-forward svc/torghut 8081:80`
   - `curl -fsS "http://127.0.0.1:8081/trading/status" | jq .`
   - `curl -fsS "http://127.0.0.1:8081/metrics" | rg '^torghut_trading_'`
3. Validate signal freshness and TA pipeline health.
   - `kubectl -n torghut get deploy torghut-clickhouse-guardrails-exporter torghut-ws torghut-ta`
   - Check `TorghutSignalsStaleDuringMarketHours` and `TorghutMicrobarsStaleDuringMarketHours` alerts.
4. Check Jangar SSE health for control-plane dashboards.
   - Review Jangar logs for `control-plane` stream errors.
   - Verify the control-plane UI connection in Jangar (`/agents/control-plane`).

## Mitigations

- If decisions are stalled or LLM errors spike, force LLM shadow-only mode and keep trading in paper mode until
  upstream failures resolve.
- If trading decisions are stalled due to missing TA data, prioritize restoring torghut-ws + torghut-ta pipelines.
- If SSE errors persist, restart Jangar and verify `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` connectivity.
- As a rollback, disable quant control-plane compute:
  - Set `JANGAR_TORGHUT_QUANT_CONTROL_PLANE_ENABLED=false` in GitOps and sync the Jangar app.

## Notes

- Jangar emits quant control-plane counters for frame cadence and error monitoring:
  - `jangar_torghut_quant_frames_total{window}`
  - `jangar_torghut_quant_stale_frames_total{window}`
  - `jangar_torghut_quant_compute_errors_total{stage}`
- Threshold-based quant alerts (drawdown/Sharpe/etc.) are computed inside Jangar and exposed via the control-plane
  alert API. Before enabling paging on those, validate thresholds in paper mode and ensure session-suppression is
  correct for your market calendar.
