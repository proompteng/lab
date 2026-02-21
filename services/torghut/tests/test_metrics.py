from __future__ import annotations

from unittest import TestCase

from app.metrics import render_trading_metrics
from app.trading.decisions import DecisionRuntimeTelemetry
from app.trading.scheduler import TradingMetrics
from app.trading.strategy_runtime import RuntimeObservation


class TestTradingMetrics(TestCase):
    def test_no_signal_reason_and_streak_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.record_no_signal("cursor_ahead_of_stream")
        metrics.no_signal_streak = 2
        metrics.no_signal_reason_streak["cursor_ahead_of_stream"] = 1

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn(
            'torghut_trading_no_signal_reason_total{reason="cursor_ahead_of_stream"} 1',
            payload,
        )
        self.assertIn(
            'torghut_trading_no_signal_reason_streak{reason="cursor_ahead_of_stream"} 1',
            payload,
        )
        self.assertIn(
            'torghut_trading_no_signal_streak{service="torghut"} 2',
            payload,
        )
        self.assertIn("# TYPE torghut_trading_no_signal_streak gauge", payload)

    def test_signal_lag_and_staleness_alerts_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.record_signal_staleness_alert("empty_batch_advanced")
        metrics.signal_lag_seconds = 61

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn(
            'torghut_trading_signal_staleness_alert_total{reason="empty_batch_advanced"} 1',
            payload,
        )
        self.assertIn(
            'torghut_trading_signal_lag_seconds{service="torghut"} 61',
            payload,
        )
        self.assertIn(
            "# TYPE torghut_trading_signal_staleness_alert_total counter", payload
        )
        self.assertIn("# TYPE torghut_trading_signal_lag_seconds gauge", payload)

    def test_market_context_reason_metrics_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.record_market_context_result(
            "market_context_domain_error", shadow_mode=True
        )
        metrics.record_llm_policy_resolution("compliant")
        metrics.record_llm_policy_resolution("intentional_exception")
        metrics.record_llm_policy_resolution("violation")
        metrics.llm_fail_mode_exception_total = 2
        metrics.llm_abstain_total = 1
        metrics.llm_escalate_total = 1
        metrics.llm_policy_fallback_total = 2

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn(
            'torghut_trading_llm_market_context_reason_total{reason="market_context_domain_error"} 1',
            payload,
        )
        self.assertIn(
            'torghut_trading_llm_market_context_shadow_total{reason="market_context_domain_error"} 1',
            payload,
        )
        self.assertIn(
            'torghut_trading_llm_policy_resolution_total{classification="compliant"} 1',
            payload,
        )
        self.assertIn(
            'torghut_trading_llm_policy_resolution_total{classification="intentional_exception"} 1',
            payload,
        )
        self.assertIn(
            'torghut_trading_llm_policy_resolution_total{classification="violation"} 1',
            payload,
        )
        self.assertIn("torghut_trading_llm_fail_mode_exception_total 2", payload)
        self.assertIn("torghut_trading_llm_abstain_total 1", payload)
        self.assertIn("torghut_trading_llm_escalate_total 1", payload)
        self.assertIn("torghut_trading_llm_policy_fallback_total 2", payload)

    def test_committee_metrics_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.record_llm_committee_member(
            role="risk_critic",
            verdict="veto",
            latency_ms=42,
            schema_error=False,
        )
        metrics.record_llm_committee_member(
            role="policy_judge",
            verdict="approve",
            latency_ms=17,
            schema_error=True,
        )
        metrics.record_llm_committee_veto_alignment(
            committee_veto=True,
            deterministic_veto=True,
        )

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn(
            'torghut_trading_llm_committee_requests_total{role="risk_critic"} 1',
            payload,
        )
        self.assertIn(
            'torghut_trading_llm_committee_latency_ms{role="risk_critic"} 42', payload
        )
        self.assertIn(
            'torghut_trading_llm_committee_verdict_total{role="risk_critic",verdict="veto"} 1',
            payload,
        )
        self.assertIn("torghut_trading_llm_committee_schema_error_total 1", payload)
        self.assertIn("torghut_trading_llm_committee_veto_alignment_total 1", payload)
        self.assertIn("torghut_trading_llm_committee_veto_alignment_rate 1.0", payload)

    def test_order_feed_counters_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.order_feed_messages_total = 3
        metrics.order_feed_events_persisted_total = 2
        metrics.order_feed_duplicates_total = 1

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn("torghut_trading_order_feed_messages_total 3", payload)
        self.assertIn("torghut_trading_order_feed_events_persisted_total 2", payload)
        self.assertIn("torghut_trading_order_feed_duplicates_total 1", payload)

    def test_tca_summary_metrics_are_exported(self) -> None:
        metrics = TradingMetrics()
        payload = render_trading_metrics(
            {
                **metrics.__dict__,
                "tca_summary": {
                    "order_count": 3,
                    "avg_slippage_bps": 12.5,
                    "avg_shortfall_notional": 1.25,
                    "avg_churn_ratio": 0.4,
                    "avg_divergence_bps": 2.1,
                },
            }
        )
        self.assertIn("torghut_trading_tca_order_count 3.0", payload)
        self.assertIn("torghut_trading_tca_avg_slippage_bps 12.5", payload)
        self.assertIn("torghut_trading_tca_avg_shortfall_notional 1.25", payload)
        self.assertIn("torghut_trading_tca_avg_churn_ratio 0.4", payload)
        self.assertIn("torghut_trading_tca_avg_divergence_bps 2.1", payload)

    def test_allocator_multiplier_metrics_preserve_pipe_delimited_regime_labels(self) -> None:
        metrics = TradingMetrics()
        payload = render_trading_metrics(
            {
                **metrics.__dict__,
                "allocator_multiplier_total": {
                    "vol=high|trend=up|liq=tight|stress|0.75": 3
                },
            }
        )
        self.assertIn(
            'torghut_trading_allocation_multiplier_total{regime="vol=high|trend=up|liq=tight",fragility_state="stress",multiplier="0.75"} 3',
            payload,
        )

    def test_route_provenance_metrics_are_exported(self) -> None:
        metrics = TradingMetrics()
        payload = render_trading_metrics(
            {
                **metrics.__dict__,
                "route_provenance": {
                    "total": 25,
                    "missing": 1,
                    "unknown": 2,
                    "mismatch": 3,
                    "coverage_ratio": 0.96,
                    "unknown_ratio": 0.08,
                    "mismatch_ratio": 0.12,
                },
            }
        )
        self.assertIn("torghut_trading_route_provenance_total 25", payload)
        self.assertIn("torghut_trading_route_provenance_missing_total 1", payload)
        self.assertIn("torghut_trading_route_provenance_unknown_total 2", payload)
        self.assertIn("torghut_trading_route_provenance_mismatch_total 3", payload)
        self.assertIn("torghut_trading_route_provenance_coverage_ratio 0.96", payload)

    def test_strategy_runtime_metrics_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.strategy_events_total["legacy-1"] = 5
        metrics.strategy_intents_total["legacy-1"] = 2
        metrics.strategy_errors_total["legacy-1"] = 1
        metrics.strategy_latency_ms["legacy-1"] = 7
        metrics.intent_conflict_total = 1
        metrics.strategy_runtime_isolated_failures_total = 1
        metrics.strategy_runtime_fallback_total = 2

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn(
            'torghut_trading_strategy_events_total{strategy_id="legacy-1"} 5', payload
        )
        self.assertIn(
            'torghut_trading_strategy_intents_total{strategy_id="legacy-1"} 2', payload
        )
        self.assertIn(
            'torghut_trading_strategy_errors_total{strategy_id="legacy-1"} 1', payload
        )
        self.assertIn(
            'torghut_trading_strategy_latency_ms{strategy_id="legacy-1"} 7', payload
        )
        self.assertIn("torghut_trading_intent_conflict_total 1", payload)
        self.assertIn(
            "torghut_trading_strategy_runtime_isolated_failures_total 1", payload
        )
        self.assertIn("torghut_trading_strategy_runtime_fallback_total 2", payload)

    def test_forecast_router_metrics_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.forecast_router_inference_latency_ms['chronos'] = 98
        metrics.forecast_router_fallback_total['calibration_below_threshold'] = 3
        metrics.forecast_calibration_error['chronos|AAPL|1m'] = '0.07'
        metrics.forecast_route_selection_total['chronos|AAPL|1m|trend'] = 5

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn(
            'torghut_forecast_router_inference_latency_ms{model_family="chronos"} 98',
            payload,
        )
        self.assertIn(
            'torghut_forecast_router_fallback_total{reason="calibration_below_threshold"} 3',
            payload,
        )
        self.assertIn(
            'torghut_forecast_calibration_error{model_family="chronos",symbol="AAPL",horizon="1m"} 0.07',
            payload,
        )
        self.assertIn(
            'torghut_forecast_route_selection_total{model_family="chronos",route_key="AAPL|1m|trend"} 5',
            payload,
        )

    def test_record_strategy_runtime_telemetry_updates_counters(self) -> None:
        metrics = TradingMetrics()
        metrics.record_strategy_runtime(
            DecisionRuntimeTelemetry(
                mode="scheduler_v3",
                runtime_enabled=True,
                fallback_to_legacy=True,
                observation=RuntimeObservation(
                    strategy_events_total={"s1": 2},
                    strategy_intents_total={"s1": 1},
                    strategy_errors_total={"s1": 1},
                    strategy_latency_ms={"s1": 9},
                    intent_conflicts_total=1,
                    isolated_failures_total=1,
                ),
            )
        )
        self.assertEqual(metrics.strategy_runtime_fallback_total, 1)
        self.assertEqual(metrics.strategy_events_total.get("s1"), 2)
        self.assertEqual(metrics.strategy_intents_total.get("s1"), 1)
        self.assertEqual(metrics.strategy_errors_total.get("s1"), 1)
        self.assertEqual(metrics.strategy_latency_ms.get("s1"), 9)
        self.assertEqual(metrics.intent_conflict_total, 1)
        self.assertEqual(metrics.strategy_runtime_isolated_failures_total, 1)

    def test_feature_quality_metrics_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.feature_null_rate = {"price": 0.5}
        metrics.feature_staleness_ms_p95 = 1234
        metrics.feature_duplicate_ratio = 0.2
        metrics.feature_schema_mismatch_total = 2

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn('torghut_trading_feature_null_rate{field="price"} 0.5', payload)
        self.assertIn("torghut_trading_feature_staleness_ms_p95 1234", payload)
        self.assertIn("torghut_trading_feature_duplicate_ratio 0.2", payload)
        self.assertIn("torghut_trading_feature_schema_mismatch_total 2", payload)

    def test_evidence_continuity_metrics_use_gauge_and_counter_types(self) -> None:
        metrics = TradingMetrics()
        metrics.evidence_continuity_checks_total = 3
        metrics.evidence_continuity_failures_total = 1
        metrics.evidence_continuity_last_checked_ts_seconds = 1700000000
        metrics.evidence_continuity_last_success_ts_seconds = 1700000100
        metrics.evidence_continuity_last_failed_runs = 2

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn("torghut_trading_evidence_continuity_checks_total 3", payload)
        self.assertIn("torghut_trading_evidence_continuity_failures_total 1", payload)
        self.assertIn(
            "torghut_trading_evidence_continuity_last_checked_ts_seconds 1700000000",
            payload,
        )
        self.assertIn(
            "torghut_trading_evidence_continuity_last_success_ts_seconds 1700000100",
            payload,
        )
        self.assertIn("torghut_trading_evidence_continuity_last_failed_runs 2", payload)
        self.assertIn(
            "# TYPE torghut_trading_evidence_continuity_last_checked_ts_seconds gauge",
            payload,
        )

    def test_uncertainty_metrics_are_exported(self) -> None:
        metrics = TradingMetrics()
        metrics.calibration_coverage_error = 0.02
        metrics.conformal_interval_width = 0.74
        metrics.regime_shift_score = 0.41
        metrics.uncertainty_gate_action_total["degrade"] = 2
        metrics.recalibration_runs_total["queued"] = 1

        payload = render_trading_metrics(metrics.__dict__)

        self.assertIn(
            'torghut_trading_calibration_coverage_error{symbol="all",horizon="autonomy"} 0.02',
            payload,
        )
        self.assertIn(
            'torghut_trading_conformal_interval_width{symbol="all",horizon="autonomy"} 0.74',
            payload,
        )
        self.assertIn(
            'torghut_trading_regime_shift_score{symbol="all",horizon="autonomy"} 0.41',
            payload,
        )
        self.assertIn(
            'torghut_trading_uncertainty_gate_action_total{action="degrade"} 2',
            payload,
        )
        self.assertIn(
            'torghut_trading_recalibration_runs_total{status="queued"} 1',
            payload,
        )
