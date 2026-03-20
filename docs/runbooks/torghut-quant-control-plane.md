# Torghut Quant Control Plane Runbook

## Overview

Use this runbook for alerts tied to the Jangar quant control-plane (near-real-time strategy performance) and its
upstream Torghut trading signals. This covers data freshness, decision activity, execution quality proxies, and
control-plane stream health.

This runbook is aligned with the current March 20 plan-stage architecture contracts:

- `docs/torghut/design-system/v6/42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
- `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`

When running under scoped service accounts, treat unavailable cluster capabilities (`kubectl exec`, `kubectl logs` with target
containers, or DB pod exec) as a controlled evidence gap and prioritize control-plane status surface checks instead.

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
- **TorghutQuantExecutionCleanRatioLow**: Clean execution ratio <75% for 10 minutes with active decision traffic.
- **TorghutQuantQtyBelowMinRatioHigh**: `qty_below_min` >3% of decisions over 30 minutes.
- **TorghutQuantLlmUnavailableRejectRatioHigh**: `llm_unavailable_*` reject share >2% over 30 minutes.
- **TorghutQuantLLMErrorRateHigh**: Trading LLM errors >10% of requests for 10 minutes.
- **TorghutClickHouseFreshnessQueryFallbacks**: ClickHouse guardrails freshness checks repeatedly fall back to low-memory mode for 15 minutes.
- **JangarQuantControlPlaneStreamErrors**: Control-plane SSE errors >0.05/sec for 10 minutes.
- **JangarTorghutQuantFramesMissingDuringMarketHours**: No computed `1d` frames for 5 minutes during market hours.
- **JangarTorghutQuantComputeErrors**: Quant compute loop errors >0 for 10 minutes.
- **JangarTorghutQuantStaleFramesDuringMarketHours**: Stale `1d` frames observed for 10 minutes during market hours.

## Triage checklist

1. Confirm control-plane API health.
   - `kubectl -n agents port-forward svc/agents 8080:80`
   - `curl -fsS "http://127.0.0.1:8080/ready" | jq .`
   - `curl -fsS "http://127.0.0.1:8080/api/agents/control-plane/status?namespace=agents" | jq .`
   - For lane-scoped health checks, include explicit strategy/account/window filters on Jangar quant health:
     `curl -fsS "http://127.0.0.1:8080/api/torghut/trading/control-plane/quant/health?strategy_id=<UUID>&account=paper&window=1d" | jq .`
   - If `/ready` and `/api/agents/control-plane/status` disagree on whether promotion or controller authority is healthy,
     treat that as an admission-receipt contradiction and block promotion until the more restrictive interpretation is
     understood.
2. Confirm Torghut trading pipeline is running.
   - `kubectl -n torghut get ksvc torghut`
   - `kubectl -n torghut port-forward svc/torghut 8081:80`
   - `curl -fsS "http://127.0.0.1:8081/db-check" | jq '{ok, schema_current, schema_graph_branch_count, schema_graph_branch_tolerance, schema_graph_lineage_errors, schema_graph_lineage_warnings}'`
   - `curl -fsS "http://127.0.0.1:8081/trading/status" | jq .`
   - `curl -fsS "http://127.0.0.1:8081/trading/status" | jq '{dependency_quorum: .hypotheses.dependency_quorum, alpha_readiness: .control_plane_contract | {alpha_readiness_hypotheses_total, alpha_readiness_blocked_total, alpha_readiness_shadow_total, alpha_readiness_canary_live_total, alpha_readiness_scaled_live_total, alpha_readiness_dependency_quorum_decision}}'`
   - `curl -fsS "http://127.0.0.1:8081/trading/status" | jq '.hypotheses.items[] | {hypothesis_id, state, capital_stage, promotion_eligible, rollback_required, reasons}'`
   - `curl -fsS "http://127.0.0.1:8081/metrics" | rg '^torghut_trading_'`
   - `curl -fsS "http://127.0.0.1:8081/metrics" | rg 'torghut_trading_(signal_continuity_actionable|signal_continuity_alert_active|signal_actionable_staleness_total|signal_expected_staleness_total|universe_fail_safe_reason_total|universe_symbols_count|universe_cache_age_seconds)'`
   - `curl -fsS "http://127.0.0.1:8081/metrics" | rg 'torghut_trading_(hypothesis_state_total|hypothesis_capital_stage_total|alpha_readiness_hypotheses_total|alpha_readiness_promotion_eligible_total|alpha_readiness_rollback_required_total)'`
   - `kubectl cnpg psql -n torghut torghut-db -- -d torghut -c "select alpaca_account_label, status, count(*) from trade_decisions where created_at >= now() - interval '1 day' group by alpaca_account_label, status order by alpaca_account_label, status;"`
   - Treat account lanes independently; stale legacy lanes can hide active-lane degradation.
   - If `schema_graph_lineage_errors` is non-empty, treat as migration-lineage divergence and pause rollout promotion until migration governance review is complete.
   - If `dependency_quorum.decision == "block"` or (`dependency_quorum.decision == "delay"` with `dependency_quorum.degradation_scope` that blocks capital progress), treat the affected control-plane segment as the active blocker and verify impact before disabling promotion.
   - If `dependency_quorum.degradation_scope` is set to `single_capability`, pause affected capital movement paths only and confirm other lanes remain evaluable before broad actions.
   - If a single hypothesis is `blocked` or `shadow`, do not disable the whole service by default; verify the specific blocker reasons and keep unaffected lanes observable.
   - If `live_submission_gate.allowed == true` while `alpha_readiness_promotion_eligible_total == 0`, or while
     `critical_toggle_parity.status == "diverged"`, or while required quant/market-context evidence is stale, treat the
     state as a capital-lease contradiction and block rollout until the most restrictive interpretation is satisfied.
   - `live_submission_gate` is now the shared scheduler/status decision surface. Any non-shadow capital requires:
     - `alpha_readiness_promotion_eligible_total > 0`
     - no capital-critical mismatch in `critical_toggle_parity_blocking_mismatches`
     - non-empty quant latest-store evidence from Jangar
     - healthy options bootstrap for options-dependent hypotheses
     - a fresh capital lease once the March 20 architecture lands
   - `quant_evidence` is the Jangar-backed latest-store probe used by the shared gate. When it is required and not
     healthy, the gate now demotes to `capital_state = "observe"` with one of:
     `quant_latest_metrics_empty`, `quant_latest_store_alarm`, `quant_metrics_update_missing`,
     `quant_pipeline_stages_missing`, or `quant_health_fetch_failed`.
   - If `live_submission_gate.reason = "critical_toggle_parity_diverged"` or
     `alpha_readiness_not_promotion_eligible` or a `quant_*` blocker, treat the gate as fail-closed and resolve the underlying config or
     evidence gap before retrying canary progression.
   - Per-lane blockers are now scoped via each hypothesis manifest dependency capabilities, so a degraded dependency (for example
     `jangar_dependency_delay`) should only affect hypotheses that explicitly require that capability.
   - Read segment output from `dependency_quorum.segments` to confirm impact: check each `segment`, `status`, `scope`, and `reasons` before rerouting incident response.
   - If rollout must tolerate the current branched graph, verify the PR also updated `scripts/check_migration_graph.py`
     allowlist evidence for the new signature; temporary GitOps overrides are not sufficient for CI.
   - After merge migrations reduce the graph back within tolerance, remove
     `TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true` from GitOps and confirm warnings clear from `/db-check`.
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
4. Validate quant latest-store evidence before any canary progression.
   - `curl -fsS "http://127.0.0.1:8080/api/torghut/trading/control-plane/quant/health?account=paper&window=1d" | jq '{status, latestMetricsCount, emptyLatestStoreAlarm, metricsPipelineLagSeconds, stages, maxStageLagSeconds}'`
   - Pass criteria:
     - `latestMetricsCount > 0`
     - `emptyLatestStoreAlarm == false`
     - `status == "ok"` for the target window
   - Hard stop criteria:
     - `latestMetricsCount == 0`
     - `emptyLatestStoreAlarm == true`
     - stage list empty for the target canary window
5. Validate market-context health on active symbols (not default symbol only).
   - `SYMS=$(kubectl cnpg psql -n torghut torghut-db -- -d torghut -At -c "select distinct symbol from trade_decisions where created_at >= now() - interval '1 day' and status in ('planned','submitted','accepted','filled') order by symbol limit 8;")`
   - `for s in $SYMS; do curl -fsS "http://127.0.0.1:8080/api/torghut/market-context/health?symbol=${s}" | jq '{symbol: .symbol, healthy: .healthy, reasons: .reasons}'; done`
6. Validate options-lane bootstrap before enabling any options-dependent hypothesis.
   - `kubectl -n torghut get pods | rg 'torghut-options-(catalog|enricher|ta)|torghut-ws-options'`
   - Pass criteria:
     - no `CrashLoopBackOff` on catalog or enricher
     - no `ImagePullBackOff` on options TA
     - no sustained restart churn on `torghut-ws-options`
   - Hard stop criteria:
     - image pull failures
     - DB auth or bootstrap crashes
     - missing readiness explanation from the options services
     - open options firebreak or expired options capital lease once the March 20 architecture lands
7. Check Jangar SSE health for control-plane dashboards.
   - Review Jangar logs for `torghut-quant` stream errors.
   - Verify the quant control-plane UI connection in Jangar (`/torghut/control-plane`).
8. Verify domain telemetry correlation continuity (PostHog contract, non-critical path).
   - `curl -fsS "http://127.0.0.1:8081/trading/status" | jq '.control_plane_contract | {last_autonomy_recommendation_trace_id, domain_telemetry_event_total, domain_telemetry_dropped_total}'`
   - `curl -fsS "http://127.0.0.1:8081/trading/executions?limit=20" | jq '[.[] | {id, trade_decision_id, execution_correlation_id, execution_idempotency_key}]'`
   - Pass criteria:
     - `control_plane_contract.last_autonomy_recommendation_trace_id` is present after an autonomy cycle.
     - recent execution rows include `execution_correlation_id` and `execution_idempotency_key` fields.
     - `domain_telemetry_dropped_total` does not show sustained growth from transport/runtime errors.
   - Fail criteria:
     - correlation IDs are absent on newly-created execution rows.
     - telemetry drops grow with reasons other than expected operational modes (for example `disabled` during planned disablement).
9. Verify recovery gate thresholds before canary progression.
   - `curl -fsS "http://127.0.0.1:8081/metrics" | rg 'torghut_trading_(execution_clean_ratio|execution_reject_ratio|decision_reject_reason_total|llm_unavailable_reject_reason_total)'`
   - Acceptance thresholds for progression:
     - `torghut_trading_execution_clean_ratio >= 0.75`
     - `qty_below_min` share <= `0.03` of recent decisions
     - `llm_unavailable_*` reject share <= `0.02` of recent decisions
     - `alpha_readiness_promotion_eligible_total > 0`
     - `critical_toggle_parity_blocking_mismatches = []`
     - quant latest-store evidence is non-empty for the target window
   - Hard rollback triggers:
     - clean ratio < `0.70` for 15 minutes
     - `qty_below_min` share > `0.05` for 30 minutes
     - `llm_unavailable_*` reject share > `0.03` for 30 minutes

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
  - Avoid broad `max()` scans on large tables; use bounded UTC-window queries and exporter gauges first.
  - Keep monitoring on low-memory mode until fallback rate returns to zero.
- If reject rate is high with `alpaca_order_rejected code=40310000`:
  - Compare open sell order qty vs current position qty (`qty_available` / held inventory).
  - Cancel stale duplicate sell orders; verify new rejects shift to local precheck (`precheck_sell_qty_exceeds_available`) instead of broker reject.
- If reject rate is high with `qty_below_min`:
  - Check `decision_json.params.portfolio_sizing.output` for `limiting_constraint`, `remaining_room_notional`,
    `min_executable_notional`, and `min_executable_qty`.
  - Capacity/inventory constraints should surface as explicit reject classes (`symbol_capacity_exhausted`,
    `sell_inventory_unavailable`, `gross_exposure_capacity_exhausted`, `net_exposure_capacity_exhausted`) rather than generic `qty_below_min`.
  - For equities, enable long-only fractional quantities (`TRADING_FRACTIONAL_EQUITIES_ENABLED=true`) and verify reject reduction.
- If `TorghutQuantLlmUnavailableRejectRatioHigh` is active:
  - Inspect `torghut_trading_llm_unavailable_reason_total` and `torghut_trading_llm_unavailable_reject_reason_total`
    to isolate unavailable source classes.
  - Keep deterministic risk/firewall controls as final authority; do not bypass veto paths while investigating.
- Canary rollback gate:
  - Revert Torghut/Jangar manifests via GitOps if any hard rollback trigger persists beyond alert window.
  - Keep rollout paused until all three gate metrics recover for at least one full market session.
- If SSE errors persist, restart Jangar and verify `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` connectivity.
- As a rollback, disable quant control-plane compute:
  - Set `JANGAR_TORGHUT_QUANT_CONTROL_PLANE_ENABLED=false` in GitOps and sync the Jangar app.

## Routine drills

1. Emergency-stop rehearsal (weekly):
   - Trigger the documented rehearsal path in paper mode and capture the resulting rollback incident artifact.
   - Verify `rollback.incident_evidence_complete=true` and that the artifact path is retained in status payloads.
2. Control-plane/evidence continuity contract rehearsal (weekly):
   - Save contract snapshots from `/trading/status` and `/trading/autonomy/evidence-continuity?refresh=true`.
   - Run `services/torghut/scripts/verify_quant_readiness.py` with:
     - `--control-plane-contract <status-control-plane-contract.json>`
     - `--model-risk-evidence-package <model-risk-evidence-package.json>`
   - Require `ok=true` before closing the drill.
   - Confirm the saved control-plane contract includes `alpha_readiness_hypotheses_total`,
     `alpha_readiness_shadow_total`, `alpha_readiness_blocked_total`, and
     `alpha_readiness_dependency_quorum_decision`.

## Notes

- Jangar emits quant control-plane counters for frame cadence and error monitoring:
  - `jangar_torghut_quant_frames_total{window}`
  - `jangar_torghut_quant_stale_frames_total{window}`
  - `jangar_torghut_quant_compute_errors_total{stage}`
- Threshold-based quant alerts (drawdown/Sharpe/etc.) are computed inside Jangar and exposed via the control-plane
  alert API. Before enabling paging on those, validate thresholds in paper mode and ensure session-suppression is
  correct for your market calendar.
