from __future__ import annotations

from unittest import TestCase

from app.metrics import render_trading_metrics
from app.trading.scheduler import TradingMetrics


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
        self.assertIn('# TYPE torghut_trading_no_signal_streak gauge', payload)

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
        self.assertIn('# TYPE torghut_trading_signal_staleness_alert_total counter', payload)
        self.assertIn('# TYPE torghut_trading_signal_lag_seconds gauge', payload)
