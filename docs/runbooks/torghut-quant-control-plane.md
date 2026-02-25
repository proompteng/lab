# Torghut Quant Control Plane Runbook

## Overview

Use this runbook for alerts tied to the Jangar quant control-plane (near-real-time strategy performance) and its
upstream Torghut trading signals. This covers data freshness, decision activity, execution quality proxies, and
control-plane stream health.

## Alert thresholds

Alert rules are defined in `argocd/applications/observability/graf-mimir-rules.yaml` under
`torghut-quant-control-plane.rules` plus upstream signal chain groups (`torghut-ws.rules`,
`torghut-clickhouse.guardrails.rules`).

- **TorghutQuantDecisionsStalledDuringMarketHours**: No trading decisions for 15 minutes during market hours.
- **TorghutAutonomyNoSignalStreakDuringMarketHours**: Autonomy has consecutive no-signal windows in market hours.
- **TorghutAutonomyCursorAheadOfStreamDuringMarketHours**: Autonomy repeatedly reports cursor_ahead_of_stream in market hours.
- **TorghutSignalContinuityActionableDuringMarketHours**: Continuity classifier is actionable for sustained windows in market hours.
- **TorghutUniverseFailSafeBlocksDuringMarketHours**: Authoritative Jangar universe fail-safe blocks trading/autonomy.
- **TorghutWSDesiredSymbolsFetchFailing**: WS forwarder is stuck on cached symbols (desired-symbol polling degraded) for 15 minutes in market hours.
- **TorghutQuantOrderRejectionRateHigh**: Rejected orders >20% of submitted orders for 10 minutes.
- **TorghutQuantLLMErrorRateHigh**: Trading LLM errors >10% of requests for 10 minutes.
- **TorghutClickHouseFreshnessQueryFallbacks**: ClickHouse guardrails freshness checks repeatedly fall back to low-memory mode for 15 minutes.
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
   - `curl -fsS "http://127.0.0.1:8081/metrics" | rg 'torghut_trading_(signal_continuity_actionable|signal_continuity_alert_active|signal_actionable_staleness_total|signal_expected_staleness_total|universe_fail_safe_reason_total|universe_symbols_count|universe_cache_age_seconds)'`
3. Validate signal freshness and TA pipeline health.
   - `kubectl -n torghut get deploy torghut-clickhouse-guardrails-exporter torghut-ws torghut-ta`
   - `kubectl -n torghut port-forward svc/torghut-ws 19090:9090`
   - `curl -fsS http://127.0.0.1:19090/metrics | rg '^torghut_ws_desired_symbols_fetch_(degraded|failures_total|success_total|last_.*_ts_seconds)'`
   - `kubectl -n torghut port-forward svc/torghut-clickhouse-guardrails-exporter 19108:9108`
   - `curl -fsS http://127.0.0.1:19108/metrics | rg '^torghut_clickhouse_guardrails_(ta_signals_max_event_ts_seconds|ta_microbars_max_window_end_seconds|freshness_low_memory_mode|freshness_fallback_total)'`
   - Pass criteria:
     - `torghut_ws_desired_symbols_fetch_degraded` is `0`.
     - `increase(torghut_ws_desired_symbols_fetch_failures_total[15m]) == 0` (or failure bursts are short and self-healed).
     - `increase(torghut_clickhouse_guardrails_freshness_fallback_total[15m]) == 0` under normal steady state.
     - `time() - max(torghut_clickhouse_guardrails_ta_signals_max_event_ts_seconds) < 900` and
       `time() - max(torghut_clickhouse_guardrails_ta_microbars_max_window_end_seconds) < 300` in market hours.
     - `max_over_time(torghut_trading_signal_continuity_actionable{service="torghut"}[5m]) == 0` unless there is an acknowledged incident.
     - `max_over_time(torghut_trading_signal_continuity_alert_active{service="torghut"}[5m]) == 0` once continuity has recovered.
     - `increase(torghut_trading_universe_fail_safe_reason_total{service="torghut"}[15m]) == 0` in steady state.
   - Fail criteria:
     - `TorghutSignalsStaleDuringMarketHours`, `TorghutMicrobarsStaleDuringMarketHours`, `TorghutWSDesiredSymbolsFetchFailing`,
       or `TorghutClickHouseFreshnessQueryFallbacks` is firing.
4. Check Jangar SSE health for control-plane dashboards.
   - Review Jangar logs for `torghut-quant` stream errors.
   - Verify the quant control-plane UI connection in Jangar (`/control-plane/torghut/quant/`).

## Mitigations

- If decisions are stalled or LLM errors spike, force LLM shadow-only mode and keep trading in paper mode until
  upstream failures resolve.
- If trading decisions are stalled due to missing TA data, prioritize restoring torghut-ws + torghut-ta pipelines.
- If `TorghutWSDesiredSymbolsFetchFailing` is active:
  - Validate Jangar symbol API: `curl -fsS "http://127.0.0.1:8080/api/torghut/symbols" | jq .`
  - If the API is unhealthy, restore Jangar first; if healthy, restart `torghut-ws` and verify
    `torghut_ws_desired_symbols_fetch_degraded` returns to `0`.
- If `TorghutClickHouseFreshnessQueryFallbacks` is active:
  - Treat this as ClickHouse query pressure. Check disk pressure/read-only alerts and run `SYSTEM RELOAD CONFIG` only if
    ClickHouse config changed.
  - Keep monitoring on low-memory mode until fallback rate returns to zero.
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
