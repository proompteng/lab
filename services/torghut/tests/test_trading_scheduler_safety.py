from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.models import Strategy
from app.strategies.catalog import StrategyConfig, _compose_strategy_description
from app.trading.scheduler.simple_pipeline import (
    SimpleTradingPipeline,
    _target_pair_balance_state,
    _target_probe_symbol_actions,
)
from app.trading.scheduler.runtime import TradingScheduler
from app.trading.scheduler.safety import (
    _coerce_recovery_reason_sequence,
    _is_recoverable_emergency_stop_reason,
    _split_emergency_stop_reasons,
)


class _OrderFirewallStub:
    def __init__(self) -> None:
        self.cancel_all_calls = 0

    def status(self) -> object:
        class _Status:
            kill_switch_enabled = False
            reason = "ok"

        return _Status()

    def cancel_all_orders(self) -> list[dict[str, object]]:
        self.cancel_all_calls += 1
        return [{"id": "o-1"}]


class _PipelineStub:
    def __init__(self) -> None:
        self.order_firewall = _OrderFirewallStub()


class TestTradingSchedulerSafety(TestCase):
    def setUp(self) -> None:
        self._snapshot = {
            "trading_autonomy_artifact_dir": config.settings.trading_autonomy_artifact_dir,
            "trading_emergency_stop_enabled": config.settings.trading_emergency_stop_enabled,
            "trading_simulation_enabled": config.settings.trading_simulation_enabled,
            "trading_allow_shorts": config.settings.trading_allow_shorts,
            "trading_mode": config.settings.trading_mode,
            "trading_simple_paper_route_probe_enabled": (
                config.settings.trading_simple_paper_route_probe_enabled
            ),
            "trading_emergency_stop_recovery_cycles": config.settings.trading_emergency_stop_recovery_cycles,
            "trading_rollback_signal_lag_seconds_limit": config.settings.trading_rollback_signal_lag_seconds_limit,
            "trading_rollback_fallback_ratio_limit": config.settings.trading_rollback_fallback_ratio_limit,
            "trading_rollback_autonomy_failure_streak_limit": config.settings.trading_rollback_autonomy_failure_streak_limit,
            "trading_rollback_max_drawdown_limit": config.settings.trading_rollback_max_drawdown_limit,
            "trading_signal_staleness_alert_critical_reasons_raw": (
                config.settings.trading_signal_staleness_alert_critical_reasons_raw
            ),
            "trading_rollback_signal_staleness_alert_streak_limit": (
                config.settings.trading_rollback_signal_staleness_alert_streak_limit
            ),
            "trading_signal_market_closed_expected_reasons_raw": (
                config.settings.trading_signal_market_closed_expected_reasons_raw
            ),
            "trading_signal_bootstrap_grace_seconds": (
                config.settings.trading_signal_bootstrap_grace_seconds
            ),
        }

    def tearDown(self) -> None:
        config.settings.trading_autonomy_artifact_dir = self._snapshot[
            "trading_autonomy_artifact_dir"
        ]
        config.settings.trading_emergency_stop_enabled = self._snapshot[
            "trading_emergency_stop_enabled"
        ]
        config.settings.trading_simulation_enabled = self._snapshot[
            "trading_simulation_enabled"
        ]
        config.settings.trading_allow_shorts = self._snapshot["trading_allow_shorts"]
        config.settings.trading_mode = self._snapshot["trading_mode"]
        config.settings.trading_simple_paper_route_probe_enabled = self._snapshot[
            "trading_simple_paper_route_probe_enabled"
        ]
        config.settings.trading_emergency_stop_recovery_cycles = self._snapshot[
            "trading_emergency_stop_recovery_cycles"
        ]
        config.settings.trading_rollback_signal_lag_seconds_limit = self._snapshot[
            "trading_rollback_signal_lag_seconds_limit"
        ]
        config.settings.trading_rollback_fallback_ratio_limit = self._snapshot[
            "trading_rollback_fallback_ratio_limit"
        ]
        config.settings.trading_rollback_autonomy_failure_streak_limit = self._snapshot[
            "trading_rollback_autonomy_failure_streak_limit"
        ]
        config.settings.trading_rollback_max_drawdown_limit = self._snapshot[
            "trading_rollback_max_drawdown_limit"
        ]
        config.settings.trading_signal_staleness_alert_critical_reasons_raw = (
            self._snapshot["trading_signal_staleness_alert_critical_reasons_raw"]
        )
        config.settings.trading_rollback_signal_staleness_alert_streak_limit = (
            self._snapshot["trading_rollback_signal_staleness_alert_streak_limit"]
        )
        config.settings.trading_signal_market_closed_expected_reasons_raw = (
            self._snapshot["trading_signal_market_closed_expected_reasons_raw"]
        )
        config.settings.trading_signal_bootstrap_grace_seconds = self._snapshot[
            "trading_signal_bootstrap_grace_seconds"
        ]

    def test_simulation_run_context_reset_clears_run_scoped_safety_state(self) -> None:
        config.settings.trading_simulation_enabled = True
        scheduler = TradingScheduler()
        scheduler._active_simulation_run_id = "sim-run-1"
        scheduler.state.last_error = "stale_error"
        scheduler.state.last_ingest_reason = "no_signals_in_window"
        scheduler.state.last_signal_continuity_state = "actionable_source_fault"
        scheduler.state.last_signal_continuity_reason = "no_signals_in_window"
        scheduler.state.last_signal_continuity_actionable = True
        scheduler.state.signal_continuity_alert_active = True
        scheduler.state.signal_continuity_alert_reason = "no_signals_in_window"
        scheduler.state.signal_continuity_alert_started_at = datetime.now(timezone.utc)
        scheduler.state.signal_continuity_alert_last_seen_at = datetime.now(
            timezone.utc
        )
        scheduler.state.signal_continuity_recovery_streak = 2
        scheduler.state.autonomy_no_signal_streak = 4
        scheduler.state.last_evidence_continuity_report = {"status": "stale"}
        scheduler.state.autonomy_failure_streak = 2
        scheduler.state.universe_fail_safe_blocked = True
        scheduler.state.universe_fail_safe_block_reason = "stale_block"
        scheduler.state.emergency_stop_active = True
        scheduler.state.emergency_stop_reason = (
            "signal_staleness_streak_exceeded:no_signals_in_window:3"
        )
        scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
        scheduler.state.emergency_stop_resolved_at = datetime.now(timezone.utc)
        scheduler.state.emergency_stop_recovery_streak = 1
        scheduler.state.rollback_incident_evidence_path = "/tmp/stale-incident.json"
        scheduler.state.metrics.no_signal_streak = 4
        scheduler.state.metrics.no_signal_reason_streak = {"no_signals_in_window": 4}
        scheduler.state.metrics.signal_lag_seconds = 91
        scheduler.state.metrics.signal_continuity_actionable = 1
        scheduler.state.metrics.record_signal_continuity_alert_state(
            active=True,
            recovery_streak=2,
        )

        with patch(
            "app.trading.scheduler.runtime.active_simulation_runtime_context",
            return_value={"run_id": "sim-run-2"},
        ):
            scheduler._sync_simulation_run_context()

        self.assertEqual(scheduler._active_simulation_run_id, "sim-run-2")
        self.assertIsNone(scheduler.state.last_error)
        self.assertIsNone(scheduler.state.last_ingest_reason)
        self.assertIsNone(scheduler.state.last_signal_continuity_state)
        self.assertIsNone(scheduler.state.last_signal_continuity_reason)
        self.assertIsNone(scheduler.state.last_signal_continuity_actionable)
        self.assertFalse(scheduler.state.signal_continuity_alert_active)
        self.assertIsNone(scheduler.state.signal_continuity_alert_reason)
        self.assertIsNone(scheduler.state.signal_continuity_alert_started_at)
        self.assertIsNone(scheduler.state.signal_continuity_alert_last_seen_at)
        self.assertEqual(scheduler.state.signal_continuity_recovery_streak, 0)
        self.assertIsNotNone(scheduler.state.signal_bootstrap_started_at)
        self.assertIsNone(scheduler.state.signal_bootstrap_completed_at)
        self.assertEqual(scheduler.state.autonomy_no_signal_streak, 0)
        self.assertIsNone(scheduler.state.last_evidence_continuity_report)
        self.assertEqual(scheduler.state.autonomy_failure_streak, 0)
        self.assertFalse(scheduler.state.universe_fail_safe_blocked)
        self.assertIsNone(scheduler.state.universe_fail_safe_block_reason)
        self.assertFalse(scheduler.state.emergency_stop_active)
        self.assertIsNone(scheduler.state.emergency_stop_reason)
        self.assertIsNone(scheduler.state.emergency_stop_triggered_at)
        self.assertIsNone(scheduler.state.emergency_stop_resolved_at)
        self.assertEqual(scheduler.state.emergency_stop_recovery_streak, 0)
        self.assertIsNone(scheduler.state.rollback_incident_evidence_path)
        self.assertEqual(scheduler.state.metrics.no_signal_streak, 0)
        self.assertEqual(scheduler.state.metrics.no_signal_reason_streak, {})
        self.assertIsNone(scheduler.state.metrics.signal_lag_seconds)
        self.assertEqual(scheduler.state.metrics.signal_continuity_actionable, 0)
        self.assertEqual(scheduler.state.metrics.signal_continuity_alert_active, 0)
        self.assertEqual(
            scheduler.state.metrics.signal_continuity_alert_recovery_streak, 0
        )

    def test_hpairs_target_plan_uses_balanced_pair_actions_and_identity(self) -> None:
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
        }
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="H-PAIRS",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("75000"),
        )

        symbol_actions = _target_probe_symbol_actions(
            target,
            ["AAPL", "AMZN"],
        )
        metadata = SimpleTradingPipeline._paper_route_target_source_decision_metadata(
            target=target,
            strategy=strategy,
            symbol="AAPL",
            window_start=window_start,
            window_end=window_end,
            max_notional=Decimal("63180"),
        )
        metadata["paper_route_probe_symbol_actions"] = symbol_actions
        metadata["paper_route_probe_pair_balance_state"] = _target_pair_balance_state(
            target,
            symbol_actions,
        )

        self.assertEqual(symbol_actions, {"AAPL": "buy", "AMZN": "sell"})
        self.assertEqual(metadata["paper_route_probe_pair_balance_state"], "balanced")
        self.assertEqual(metadata["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(metadata["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(
            metadata["source_candidate_ids"],
            ["c88421d619759b2cfaa6f4d0"],
        )
        self.assertEqual(metadata["source_hypothesis_ids"], ["H-PAIRS-01"])
        self.assertFalse(metadata["promotion_allowed"])
        self.assertFalse(metadata["final_promotion_allowed"])

    def test_hpairs_target_plan_balances_missing_leg_from_existing_action(
        self,
    ) -> None:
        target = {
            "strategy_family": "microbar_cross_sectional_pairs",
            "paper_route_probe_symbol_actions": {"AAPL": "buy"},
        }

        symbol_actions = _target_probe_symbol_actions(target, ["AAPL", "AMZN"])

        self.assertEqual(symbol_actions, {"AAPL": "buy", "AMZN": "sell"})
        self.assertEqual(_target_pair_balance_state(target, symbol_actions), "balanced")

    def test_hpairs_target_plan_parses_sequence_symbol_actions(self) -> None:
        target = {
            "paper_route_probe_pair_balance_required": False,
            "paper_route_probe_symbol_actions": [
                {"symbol": "AAPL", "action": "long"},
                {"symbol": "AMZN", "side": "short"},
            ],
        }

        symbol_actions = _target_probe_symbol_actions(target, ["AAPL", "AMZN"])

        self.assertEqual(symbol_actions, {"AAPL": "buy", "AMZN": "sell"})
        self.assertEqual(
            _target_pair_balance_state(target, symbol_actions),
            "not_required",
        )

    def test_hpairs_target_plan_balances_missing_buy_from_existing_short(
        self,
    ) -> None:
        target = {
            "strategy_family": "microbar_cross_sectional_pairs",
            "paper_route_probe_symbol_actions": {"AAPL": "short"},
        }

        symbol_actions = _target_probe_symbol_actions(target, ["AAPL", "AMZN"])

        self.assertEqual(symbol_actions, {"AAPL": "sell", "AMZN": "buy"})
        self.assertEqual(_target_pair_balance_state(target, symbol_actions), "balanced")

    def test_hpairs_target_plan_marks_unbalanced_actions_imbalanced(self) -> None:
        target = {"paper_route_probe_pair_balance_required": True}

        self.assertEqual(
            _target_pair_balance_state(target, {"AAPL": "buy"}),
            "imbalanced",
        )

    def test_paper_route_source_decisions_skip_imbalanced_pair_targets(self) -> None:
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        target = {
            "strategy_family": "microbar_cross_sectional_pairs",
            "paper_route_probe_pair_balance_required": True,
            "paper_route_probe_symbols": ["AAPL", "AMZN", "MSFT"],
            "paper_route_probe_symbol_actions": {
                "AAPL": "buy",
                "AMZN": "sell",
                "MSFT": "buy",
            },
            "paper_route_probe_next_session_max_notional": "1000",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
        }
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN", "MSFT"],
            max_notional_per_trade=Decimal("1000"),
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)
        setattr(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            lambda **_kwargs: ({"AAPL", "AMZN", "MSFT"}, None, [target]),
        )
        setattr(
            pipeline,
            "_paper_route_target_strategy",
            lambda _target, _strategies: strategy,
        )
        setattr(
            pipeline,
            "_paper_route_target_strategy_symbols",
            lambda _strategy: {"AAPL", "AMZN", "MSFT"},
        )
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=window_start,
        ):
            decisions = pipeline._paper_route_target_source_decisions(
                strategies=[strategy],
                allowed_symbols=set(),
            )

        self.assertEqual(decisions, [])

    def test_paper_route_source_decisions_skip_balanced_pair_when_shorts_disabled(
        self,
    ) -> None:
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        target = {
            "strategy_family": "microbar_cross_sectional_pairs",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_symbol_actions": {"AAPL": "buy", "AMZN": "sell"},
            "paper_route_probe_next_session_max_notional": "1000",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
        }
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("1000"),
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)
        setattr(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            lambda **_kwargs: ({"AAPL", "AMZN"}, None, [target]),
        )
        setattr(
            pipeline,
            "_paper_route_target_strategy",
            lambda _target, _strategies: strategy,
        )
        setattr(
            pipeline,
            "_paper_route_target_strategy_symbols",
            lambda _strategy: {"AAPL", "AMZN"},
        )
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = False

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=window_start,
        ):
            decisions = pipeline._paper_route_target_source_decisions(
                strategies=[strategy],
                allowed_symbols=set(),
            )

        self.assertEqual(decisions, [])

    def test_hpairs_target_strategy_matches_declared_catalog_strategy_id(self) -> None:
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "strategy_id": "microbar_cross_sectional_pairs_v1@research",
            "source_manifest_ref": "runtime-window:H-PAIRS-01",
            "source_decision_readiness": {"ready": True, "blockers": []},
            "bounded_evidence_collection_authorized": True,
            "evidence_collection_ok": True,
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_symbol_actions": {"AAPL": "buy", "AMZN": "sell"},
            "paper_route_probe_next_session_max_notional": "1000",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
        }
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-cross-sectional-pairs-v1",
                    strategy_id="microbar_cross_sectional_pairs_v1@research",
                    strategy_type="microbar_cross_sectional_pairs_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_symbols=["AAPL", "AMZN"],
                    max_notional_per_trade=Decimal("1000"),
                    params={"max_pair_legs": "2"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("1000"),
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)
        setattr(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            lambda **_kwargs: ({"AAPL", "AMZN"}, None, [target]),
        )
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=window_start,
        ):
            scope = pipeline._bounded_paper_route_signal_scope([strategy])
            decisions = pipeline._paper_route_target_source_decisions(
                strategies=[strategy],
                allowed_symbols=set(),
                positions=[],
            )

        self.assertEqual(scope, ({"AAPL", "AMZN"}, {"1Sec"}))
        self.assertEqual([decision.symbol for decision in decisions], ["AAPL", "AMZN"])
        self.assertEqual(
            [decision.params["source_decision_mode"] for decision in decisions],
            ["bounded_paper_route_collection", "bounded_paper_route_collection"],
        )
        self.assertTrue(
            all(decision.params["profit_proof_eligible"] for decision in decisions)
        )
        self.assertEqual(
            decisions[0].params["source_strategy_names"],
            ["microbar-cross-sectional-pairs-v1"],
        )

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
            self.assertIn(
                "signal_lag_exceeded", scheduler.state.emergency_stop_reason or ""
            )
            self.assertEqual(scheduler._pipeline.order_firewall.cancel_all_calls, 1)  # type: ignore[union-attr]
            evidence_path = Path(scheduler.state.rollback_incident_evidence_path or "")
            self.assertTrue(evidence_path.exists())
            payload = json.loads(evidence_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["signal_lag_seconds"], 7)

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

    def test_critical_no_signal_streak_is_suppressed_during_bootstrap_grace(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_rollback_signal_staleness_alert_streak_limit = 2
            config.settings.trading_signal_staleness_alert_critical_reasons_raw = (
                "no_signals_in_window"
            )
            config.settings.trading_signal_market_closed_expected_reasons_raw = (
                "cursor_tail_stable,empty_batch_advanced"
            )
            config.settings.trading_signal_bootstrap_grace_seconds = 180
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
            scheduler.state.signal_bootstrap_started_at = datetime.now(timezone.utc)
            scheduler.state.signal_bootstrap_completed_at = None
            scheduler.state.metrics.no_signal_reason_streak = {
                "no_signals_in_window": 3
            }

            scheduler._evaluate_safety_controls()

            self.assertFalse(scheduler.state.emergency_stop_active)
            self.assertEqual(scheduler.state.rollback_incidents_total, 0)

    def test_critical_no_signal_streak_triggers_after_bootstrap_grace_expires(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_rollback_signal_staleness_alert_streak_limit = 2
            config.settings.trading_signal_staleness_alert_critical_reasons_raw = (
                "no_signals_in_window"
            )
            config.settings.trading_signal_market_closed_expected_reasons_raw = (
                "cursor_tail_stable,empty_batch_advanced"
            )
            config.settings.trading_signal_bootstrap_grace_seconds = 180
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
            scheduler.state.signal_bootstrap_started_at = datetime.now(
                timezone.utc
            ) - timedelta(seconds=181)
            scheduler.state.signal_bootstrap_completed_at = None
            scheduler.state.metrics.no_signal_reason_streak = {
                "no_signals_in_window": 3
            }

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn(
                "signal_staleness_streak_exceeded:no_signals_in_window:3",
                scheduler.state.emergency_stop_reason or "",
            )

    def test_freshness_emergency_stop_auto_clears_after_recovery_hysteresis(
        self,
    ) -> None:
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
            scheduler.state.emergency_stop_reason = "max_drawdown_exceeded:0.1200"
            scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
            scheduler.state.metrics.signal_lag_seconds = 0

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertEqual(
                scheduler.state.emergency_stop_reason,
                "max_drawdown_exceeded:0.1200",
            )
            self.assertEqual(scheduler.state.emergency_stop_recovery_streak, 0)
            self.assertIsNone(scheduler.state.emergency_stop_resolved_at)

    def test_emergency_stop_triggers_on_drawdown_from_gate_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate.json"
            gate_path.write_text(
                json.dumps({"metrics": {"max_drawdown": "0.12"}}), encoding="utf-8"
            )
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_rollback_max_drawdown_limit = 0.08
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler.state.last_autonomy_gates = str(gate_path)

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn(
                "max_drawdown_exceeded", scheduler.state.emergency_stop_reason or ""
            )

    def test_disabled_emergency_stop_clears_latched_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = False
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler.state.emergency_stop_active = True
            scheduler.state.emergency_stop_reason = "signal_lag_exceeded:1234"
            scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
            scheduler.state.metrics.signal_lag_seconds = 9999

            scheduler._evaluate_safety_controls()

            self.assertFalse(scheduler.state.emergency_stop_active)
            self.assertIsNone(scheduler.state.emergency_stop_reason)
            self.assertIsNone(scheduler.state.emergency_stop_triggered_at)
            self.assertEqual(scheduler._pipeline.order_firewall.cancel_all_calls, 0)  # type: ignore[union-attr]

    def test_split_emergency_stop_reasons_normalizes_and_dedupes(self) -> None:
        reason = (
            "signal_lag_exceeded:10 ; signal_lag_exceeded:10; ; "
            "max_drawdown_exceeded:0.05 ; unknown;  "
        )
        self.assertEqual(
            _split_emergency_stop_reasons(reason),
            ["signal_lag_exceeded:10", "max_drawdown_exceeded:0.05"],
        )

    def test_recovery_reason_sequence_normalizes_and_dedupes(self) -> None:
        self.assertEqual(
            _coerce_recovery_reason_sequence(
                [
                    " signal_lag_exceeded:10 ",
                    "",
                    "signal_lag_exceeded:10",
                    "max_drawdown_exceeded:0.05",
                ]
            ),
            ["signal_lag_exceeded:10", "max_drawdown_exceeded:0.05"],
        )

    def test_recoverable_reason_prefix_matches_are_strict(self) -> None:
        self.assertTrue(_is_recoverable_emergency_stop_reason("signal_lag_exceeded:17"))
        self.assertTrue(
            _is_recoverable_emergency_stop_reason(
                "signal_staleness_streak_exceeded:window"
            )
        )
        self.assertFalse(
            _is_recoverable_emergency_stop_reason("max_drawdown_exceeded:0.10")
        )

    def test_split_emergency_stop_reasons_ignores_duplicates_and_whitespace(
        self,
    ) -> None:
        self.assertEqual(
            _split_emergency_stop_reasons(
                " signal_lag_exceeded:10 ;signal_lag_exceeded:10;; max_drawdown_exceeded:0.1000 ;  "
            ),
            ["signal_lag_exceeded:10", "max_drawdown_exceeded:0.1000"],
        )

    def test_emergency_stop_recovery_canonicalizes_and_merges_nonrecoverable_reasons(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config.settings.trading_autonomy_artifact_dir = tmpdir
            config.settings.trading_emergency_stop_enabled = True
            config.settings.trading_emergency_stop_recovery_cycles = 1
            scheduler = TradingScheduler()
            scheduler._pipeline = _PipelineStub()  # type: ignore[assignment]
            scheduler.state.emergency_stop_active = True
            scheduler.state.emergency_stop_reason = (
                " signal_staleness_streak_exceeded:no_signals_in_window ;"
                "signal_lag_exceeded:7; signal_lag_exceeded:7; "
            )
            scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
            scheduler.state.metrics.signal_lag_seconds = 0
            scheduler._collect_emergency_stop_reasons = lambda: (
                [
                    " signal_lag_exceeded:7 ",
                    "max_drawdown_exceeded:0.1100",
                    "signal_lag_exceeded:7",
                ],
                0.0,
                None,
            )

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertEqual(
                scheduler.state.emergency_stop_reason,
                "signal_staleness_streak_exceeded:no_signals_in_window;"
                "signal_lag_exceeded:7;"
                "max_drawdown_exceeded:0.1100",
            )

    def test_startup_shorts_policy_requires_explicit_environment(self) -> None:
        config.settings.trading_allow_shorts = True
        with patch.dict(os.environ, {}, clear=True):
            scheduler = TradingScheduler()
            with self.assertRaisesRegex(
                RuntimeError,
                "TRADING_ALLOW_SHORTS",
            ):
                scheduler._assert_trading_shorts_startup_policy()

    def test_startup_shorts_policy_metric_tracks_declared_setting(self) -> None:
        config.settings.trading_allow_shorts = False
        with patch.dict(os.environ, {"TRADING_ALLOW_SHORTS": "0"}):
            scheduler = TradingScheduler()
            scheduler._assert_trading_shorts_startup_policy()
            self.assertEqual(scheduler.state.metrics.trading_shorts_enabled, 0)
