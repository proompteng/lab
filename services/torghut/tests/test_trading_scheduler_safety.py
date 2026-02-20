from __future__ import annotations

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
            'trading_rollback_signal_lag_seconds_limit': config.settings.trading_rollback_signal_lag_seconds_limit,
            'trading_rollback_fallback_ratio_limit': config.settings.trading_rollback_fallback_ratio_limit,
            'trading_rollback_autonomy_failure_streak_limit': config.settings.trading_rollback_autonomy_failure_streak_limit,
            'trading_rollback_max_drawdown_limit': config.settings.trading_rollback_max_drawdown_limit,
        }

    def tearDown(self) -> None:
        config.settings.trading_autonomy_artifact_dir = self._snapshot['trading_autonomy_artifact_dir']
        config.settings.trading_emergency_stop_enabled = self._snapshot['trading_emergency_stop_enabled']
        config.settings.trading_rollback_signal_lag_seconds_limit = self._snapshot[
            'trading_rollback_signal_lag_seconds_limit'
        ]
        config.settings.trading_rollback_fallback_ratio_limit = self._snapshot['trading_rollback_fallback_ratio_limit']
        config.settings.trading_rollback_autonomy_failure_streak_limit = self._snapshot[
            'trading_rollback_autonomy_failure_streak_limit'
        ]
        config.settings.trading_rollback_max_drawdown_limit = self._snapshot['trading_rollback_max_drawdown_limit']

    def test_emergency_stop_triggers_on_signal_lag(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_rollback_signal_lag_seconds_limit = 5
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
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
