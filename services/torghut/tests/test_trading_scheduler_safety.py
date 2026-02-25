from __future__ import annotations

from datetime import datetime, timezone
import json
import tempfile
from pathlib import Path
from unittest import TestCase

from app import config
from app.trading.scheduler import TradingScheduler


class _OrderFirewallStub:
    def __init__(self) -> None:
        self.cancel_all_calls = 0

    def status(self) -> object:
        class _Status:
            kill_switch_enabled = False
            reason = 'ok'

        return _Status()

    def cancel_all_orders(self) -> list[dict[str, object]]:
        self.cancel_all_calls += 1
        return [{'id': 'o-1'}]


class _PipelineStub:
    def __init__(self) -> None:
        self.order_firewall = _OrderFirewallStub()


class TestTradingSchedulerSafety(TestCase):
    def setUp(self) -> None:
        self._snapshot = {
            'trading_autonomy_artifact_dir': config.settings.trading_autonomy_artifact_dir,
            'trading_emergency_stop_enabled': config.settings.trading_emergency_stop_enabled,
            'trading_emergency_stop_recovery_cycles': config.settings.trading_emergency_stop_recovery_cycles,
            'trading_rollback_signal_lag_seconds_limit': config.settings.trading_rollback_signal_lag_seconds_limit,
            'trading_rollback_fallback_ratio_limit': config.settings.trading_rollback_fallback_ratio_limit,
            'trading_rollback_autonomy_failure_streak_limit': config.settings.trading_rollback_autonomy_failure_streak_limit,
            'trading_rollback_max_drawdown_limit': config.settings.trading_rollback_max_drawdown_limit,
            'trading_signal_staleness_alert_critical_reasons_raw': (
                config.settings.trading_signal_staleness_alert_critical_reasons_raw
            ),
            'trading_rollback_signal_staleness_alert_streak_limit': (
                config.settings.trading_rollback_signal_staleness_alert_streak_limit
            ),
            'trading_signal_market_closed_expected_reasons_raw': (
                config.settings.trading_signal_market_closed_expected_reasons_raw
            ),
        }

    def tearDown(self) -> None:
        config.settings.trading_autonomy_artifact_dir = self._snapshot['trading_autonomy_artifact_dir']
        config.settings.trading_emergency_stop_enabled = self._snapshot['trading_emergency_stop_enabled']
        config.settings.trading_emergency_stop_recovery_cycles = self._snapshot[
            'trading_emergency_stop_recovery_cycles'
        ]
        config.settings.trading_rollback_signal_lag_seconds_limit = self._snapshot[
            'trading_rollback_signal_lag_seconds_limit'
        ]
        config.settings.trading_rollback_fallback_ratio_limit = self._snapshot['trading_rollback_fallback_ratio_limit']
        config.settings.trading_rollback_autonomy_failure_streak_limit = self._snapshot[
            'trading_rollback_autonomy_failure_streak_limit'
        ]
        config.settings.trading_rollback_max_drawdown_limit = self._snapshot['trading_rollback_max_drawdown_limit']
        config.settings.trading_signal_staleness_alert_critical_reasons_raw = self._snapshot[
            'trading_signal_staleness_alert_critical_reasons_raw'
        ]
        config.settings.trading_rollback_signal_staleness_alert_streak_limit = self._snapshot[
            'trading_rollback_signal_staleness_alert_streak_limit'
        ]
        config.settings.trading_signal_market_closed_expected_reasons_raw = self._snapshot[
            'trading_signal_market_closed_expected_reasons_raw'
        ]

    def test_emergency_stop_triggers_on_signal_lag(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_rollback_signal_lag_seconds_limit = 5
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
            scheduler.state.metrics.signal_lag_seconds = 7

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertEqual(scheduler.state.rollback_incidents_total, 1)
            self.assertIn('signal_lag_exceeded', scheduler.state.emergency_stop_reason or '')
            self.assertEqual(scheduler._pipeline.order_firewall.cancel_all_calls, 1)  # type: ignore[union-attr]
            evidence_path = Path(scheduler.state.rollback_incident_evidence_path or '')
            self.assertTrue(evidence_path.exists())
            payload = json.loads(evidence_path.read_text(encoding='utf-8'))
            self.assertEqual(payload['signal_lag_seconds'], 7)

    def test_signal_lag_does_not_trigger_when_market_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_rollback_signal_lag_seconds_limit = 5
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler._is_market_session_open = lambda _now=None: False  # type: ignore[method-assign]
            scheduler.state.metrics.signal_lag_seconds = 7

            scheduler._evaluate_safety_controls()

            self.assertFalse(scheduler.state.emergency_stop_active)
            self.assertEqual(scheduler.state.rollback_incidents_total, 0)
            self.assertEqual(scheduler._pipeline.order_firewall.cancel_all_calls, 0)  # type: ignore[union-attr]

    def test_critical_no_signal_streak_is_suppressed_when_market_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_rollback_signal_staleness_alert_streak_limit = 2
            config.settings.trading_signal_staleness_alert_critical_reasons_raw = (
                "no_signals_in_window"
            )
            config.settings.trading_signal_market_closed_expected_reasons_raw = (
                "no_signals_in_window,cursor_tail_stable,empty_batch_advanced"
            )
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler._is_market_session_open = lambda _now=None: False  # type: ignore[method-assign]
            scheduler.state.metrics.no_signal_reason_streak = {
                "no_signals_in_window": 3
            }

            scheduler._evaluate_safety_controls()

            self.assertFalse(scheduler.state.emergency_stop_active)
            self.assertEqual(scheduler.state.rollback_incidents_total, 0)

    def test_freshness_emergency_stop_auto_clears_after_recovery_hysteresis(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_emergency_stop_recovery_cycles = 2
            config.settings.trading_rollback_signal_lag_seconds_limit = 5
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
            scheduler.state.metrics.signal_lag_seconds = 7

            scheduler._evaluate_safety_controls()
            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertEqual(scheduler.state.emergency_stop_recovery_streak, 0)

            scheduler.state.metrics.signal_lag_seconds = 0
            scheduler._evaluate_safety_controls()
            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertEqual(scheduler.state.emergency_stop_recovery_streak, 1)

            scheduler._evaluate_safety_controls()
            self.assertFalse(scheduler.state.emergency_stop_active)
            self.assertEqual(scheduler.state.emergency_stop_recovery_streak, 0)
            self.assertIsNone(scheduler.state.emergency_stop_reason)
            self.assertIsNone(scheduler.state.emergency_stop_triggered_at)
            self.assertIsNotNone(scheduler.state.emergency_stop_resolved_at)

    def test_nonrecoverable_emergency_stop_remains_latched(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_emergency_stop_recovery_cycles = 1
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler.state.emergency_stop_active = True
            scheduler.state.emergency_stop_reason = 'max_drawdown_exceeded:0.1200'
            scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
            scheduler.state.metrics.signal_lag_seconds = 0

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertEqual(
                scheduler.state.emergency_stop_reason,
                'max_drawdown_exceeded:0.1200',
            )
            self.assertEqual(scheduler.state.emergency_stop_recovery_streak, 0)
            self.assertIsNone(scheduler.state.emergency_stop_resolved_at)

    def test_emergency_stop_triggers_on_drawdown_from_gate_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / 'gate.json'
            gate_path.write_text(json.dumps({'metrics': {'max_drawdown': '0.12'}}), encoding='utf-8')
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_rollback_max_drawdown_limit = 0.08
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler.state.last_autonomy_gates = str(gate_path)

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn('max_drawdown_exceeded', scheduler.state.emergency_stop_reason or '')

    def test_disabled_emergency_stop_clears_latched_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = False
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler.state.emergency_stop_active = True
            scheduler.state.emergency_stop_reason = 'signal_lag_exceeded:1234'
            scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
            scheduler.state.metrics.signal_lag_seconds = 9999

            scheduler._evaluate_safety_controls()

            self.assertFalse(scheduler.state.emergency_stop_active)
            self.assertIsNone(scheduler.state.emergency_stop_reason)
            self.assertIsNone(scheduler.state.emergency_stop_triggered_at)
            self.assertEqual(scheduler._pipeline.order_firewall.cancel_all_calls, 0)  # type: ignore[union-attr]
