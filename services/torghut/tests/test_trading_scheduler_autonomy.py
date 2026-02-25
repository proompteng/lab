from __future__ import annotations

import json
import tempfile
from dataclasses import dataclass
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.trading.ingest import SignalBatch
from app.trading.models import SignalEnvelope
from app.trading.scheduler import TradingScheduler, TradingState


@dataclass
class _PipelineStub:
    signals: list[SignalEnvelope]
    session_factory: object
    no_signal_reason: str | None = None
    no_signal_lag_seconds: float | None = None
    market_session_open: bool = True
    state: TradingState | None = None

    def __post_init__(self) -> None:
        self.ingestor = self
        self.order_firewall = _OrderFirewallStub()
        self.universe_resolver = SimpleNamespace(
            get_resolution=lambda: SimpleNamespace(
                symbols={"AAPL"},
                source="jangar",
                status="ok",
                reason="jangar_fetch_ok",
                fetched_at=None,
                cache_age_seconds=0,
            )
        )

    def fetch_signals_between(
        self, start: datetime, end: datetime
    ) -> list[SignalEnvelope]:
        return list(self.signals)

    def fetch_signals_with_reason(
        self,
        start: datetime,
        end: datetime,
        symbol: str | None = None,
        limit: int | None = None,
    ) -> SignalBatch:
        return SignalBatch(
            signals=list(self.signals),
            cursor_at=None,
            cursor_seq=None,
            cursor_symbol=None,
            query_start=start,
            query_end=end,
            signal_lag_seconds=self.no_signal_lag_seconds,
            no_signal_reason=self.no_signal_reason,
        )

    def record_no_signal_batch(self, batch: SignalBatch) -> None:
        if self.state is None:
            return

        self.state.last_ingest_signals_total = len(batch.signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason
        reason = batch.no_signal_reason
        normalized_reason = (reason or "unknown").strip() or "unknown"
        self.state.market_session_open = self.market_session_open
        self.state.metrics.market_session_open = 1 if self.market_session_open else 0
        if batch.signal_lag_seconds is not None:
            self.state.metrics.signal_lag_seconds = int(batch.signal_lag_seconds)
        else:
            self.state.metrics.signal_lag_seconds = None
        self.state.metrics.record_no_signal(reason)
        streak = self.state.metrics.no_signal_reason_streak.get(normalized_reason, 0)
        streak_threshold_met = (
            normalized_reason
            in {
                "no_signals_in_window",
                "cursor_tail_stable",
                "cursor_ahead_of_stream",
                "empty_batch_advanced",
            }
            and streak >= settings.trading_signal_no_signal_streak_alert_threshold
        )
        lag_threshold_met = (
            batch.signal_lag_seconds is not None
            and batch.signal_lag_seconds
            >= settings.trading_signal_stale_lag_alert_seconds
        )
        actionable = (
            normalized_reason == "cursor_ahead_of_stream"
            or self.market_session_open
            or normalized_reason
            not in settings.trading_signal_market_closed_expected_reasons
        )
        self.state.metrics.signal_continuity_actionable = 1 if actionable else 0
        self.state.last_signal_continuity_reason = normalized_reason
        self.state.last_signal_continuity_actionable = actionable
        self.state.last_signal_continuity_state = (
            "actionable_source_fault"
            if actionable
            else "expected_market_closed_staleness"
        )
        if actionable:
            self.state.metrics.record_signal_actionable_staleness(normalized_reason)
        else:
            self.state.metrics.record_signal_expected_staleness(normalized_reason)

        if actionable and (streak_threshold_met or lag_threshold_met):
            self.state.metrics.record_signal_staleness_alert(reason)
            if not self.state.signal_continuity_alert_active:
                self.state.signal_continuity_alert_started_at = datetime.now(
                    timezone.utc
                )
            self.state.signal_continuity_alert_active = True
            self.state.signal_continuity_alert_reason = normalized_reason
            self.state.signal_continuity_alert_last_seen_at = datetime.now(timezone.utc)
            self.state.signal_continuity_recovery_streak = 0
            self.state.metrics.record_signal_continuity_alert_state(
                active=True,
                recovery_streak=0,
            )
        elif actionable and self.state.signal_continuity_alert_active:
            self.state.signal_continuity_alert_reason = normalized_reason
            self.state.signal_continuity_alert_last_seen_at = datetime.now(timezone.utc)
            self.state.signal_continuity_recovery_streak = 0
            self.state.metrics.record_signal_continuity_alert_state(
                active=True,
                recovery_streak=0,
            )


class _SchedulerDependencies:
    def __init__(self) -> None:
        self.call_kwargs: dict[str, Any] = {}
        self.gate_payload: dict[str, Any] = {"recommended_mode": "paper", "gates": []}


class _OrderFirewallStub:
    def status(self) -> SimpleNamespace:
        return SimpleNamespace(kill_switch_enabled=False, reason="ok")

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        return []


def _signal_batch() -> list[SignalEnvelope]:
    return [
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={
                "macd": {"macd": "1", "signal": "0"},
                "rsi14": "58",
                "price": "100",
            },
        ),
    ]


class TestTradingSchedulerAutonomy(TestCase):
    def setUp(self) -> None:
        self._settings_snapshot = {
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_autonomy_approval_token": settings.trading_autonomy_approval_token,
            "trading_strategy_config_path": settings.trading_strategy_config_path,
            "trading_autonomy_gate_policy_path": settings.trading_autonomy_gate_policy_path,
            "trading_autonomy_artifact_dir": settings.trading_autonomy_artifact_dir,
            "trading_signal_no_signal_streak_alert_threshold": settings.trading_signal_no_signal_streak_alert_threshold,
            "trading_signal_stale_lag_alert_seconds": settings.trading_signal_stale_lag_alert_seconds,
            "trading_signal_continuity_recovery_cycles": settings.trading_signal_continuity_recovery_cycles,
            "trading_signal_staleness_alert_critical_reasons_raw": (
                settings.trading_signal_staleness_alert_critical_reasons_raw
            ),
            "trading_signal_market_closed_expected_reasons_raw": (
                settings.trading_signal_market_closed_expected_reasons_raw
            ),
            "trading_evidence_continuity_run_limit": settings.trading_evidence_continuity_run_limit,
            "trading_rollback_signal_staleness_alert_streak_limit": (
                settings.trading_rollback_signal_staleness_alert_streak_limit
            ),
            "trading_universe_source": settings.trading_universe_source,
            "trading_emergency_stop_enabled": settings.trading_emergency_stop_enabled,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_drift_governance_enabled": settings.trading_drift_governance_enabled,
            "trading_drift_live_promotion_requires_evidence": settings.trading_drift_live_promotion_requires_evidence,
            "trading_drift_live_promotion_max_evidence_age_seconds": (
                settings.trading_drift_live_promotion_max_evidence_age_seconds
            ),
            "trading_drift_rollback_on_performance": settings.trading_drift_rollback_on_performance,
            "trading_drift_rollback_reason_codes_raw": settings.trading_drift_rollback_reason_codes_raw,
            "trading_drift_max_performance_drawdown": settings.trading_drift_max_performance_drawdown,
        }

    def tearDown(self) -> None:
        settings.trading_autonomy_allow_live_promotion = self._settings_snapshot[
            "trading_autonomy_allow_live_promotion"
        ]
        settings.trading_autonomy_approval_token = self._settings_snapshot[
            "trading_autonomy_approval_token"
        ]
        settings.trading_strategy_config_path = self._settings_snapshot[
            "trading_strategy_config_path"
        ]
        settings.trading_autonomy_gate_policy_path = self._settings_snapshot[
            "trading_autonomy_gate_policy_path"
        ]
        settings.trading_autonomy_artifact_dir = self._settings_snapshot[
            "trading_autonomy_artifact_dir"
        ]
        settings.trading_signal_no_signal_streak_alert_threshold = (
            self._settings_snapshot["trading_signal_no_signal_streak_alert_threshold"]
        )
        settings.trading_signal_stale_lag_alert_seconds = self._settings_snapshot[
            "trading_signal_stale_lag_alert_seconds"
        ]
        settings.trading_signal_continuity_recovery_cycles = self._settings_snapshot[
            "trading_signal_continuity_recovery_cycles"
        ]
        settings.trading_signal_staleness_alert_critical_reasons_raw = (
            self._settings_snapshot[
                "trading_signal_staleness_alert_critical_reasons_raw"
            ]
        )
        settings.trading_signal_market_closed_expected_reasons_raw = (
            self._settings_snapshot["trading_signal_market_closed_expected_reasons_raw"]
        )
        settings.trading_evidence_continuity_run_limit = self._settings_snapshot[
            "trading_evidence_continuity_run_limit"
        ]
        settings.trading_rollback_signal_staleness_alert_streak_limit = (
            self._settings_snapshot[
                "trading_rollback_signal_staleness_alert_streak_limit"
            ]
        )
        settings.trading_universe_source = self._settings_snapshot[
            "trading_universe_source"
        ]
        settings.trading_emergency_stop_enabled = self._settings_snapshot[
            "trading_emergency_stop_enabled"
        ]
        settings.trading_autonomy_enabled = self._settings_snapshot[
            "trading_autonomy_enabled"
        ]
        settings.trading_drift_governance_enabled = self._settings_snapshot[
            "trading_drift_governance_enabled"
        ]
        settings.trading_drift_live_promotion_requires_evidence = (
            self._settings_snapshot["trading_drift_live_promotion_requires_evidence"]
        )
        settings.trading_drift_live_promotion_max_evidence_age_seconds = (
            self._settings_snapshot[
                "trading_drift_live_promotion_max_evidence_age_seconds"
            ]
        )
        settings.trading_drift_rollback_on_performance = self._settings_snapshot[
            "trading_drift_rollback_on_performance"
        ]
        settings.trading_drift_rollback_reason_codes_raw = self._settings_snapshot[
            "trading_drift_rollback_reason_codes_raw"
        ]
        settings.trading_drift_max_performance_drawdown = self._settings_snapshot[
            "trading_drift_max_performance_drawdown"
        ]

    def test_run_autonomous_cycle_uses_live_promotion_when_token_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token="live-approve-token",
            )
            outcome_path = Path(tmpdir) / "drift-outcome.json"
            outcome_path.write_text(
                json.dumps(
                    {
                        "checked_at": datetime.now(timezone.utc).isoformat(),
                        "eligible_for_live_promotion": True,
                        "reasons": [],
                    }
                ),
                encoding="utf-8",
            )
            scheduler.state.drift_last_outcome_path = str(outcome_path)
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "live")
            self.assertEqual(deps.call_kwargs["approval_token"], "live-approve-token")

    def test_run_autonomous_cycle_falls_back_to_paper_when_live_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_falls_back_to_paper_when_drift_evidence_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token="live-approve-token",
            )
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_falls_back_to_paper_when_live_token_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_uses_strategy_paths_from_settings(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                deps.call_kwargs["strategy_config_path"],
                Path(settings.trading_strategy_config_path),
            )
            self.assertEqual(
                deps.call_kwargs["gate_policy_path"],
                Path(settings.trading_autonomy_gate_policy_path),
            )

    def test_run_autonomous_cycle_passes_persistence_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertTrue(deps.call_kwargs["persist_results"])
            self.assertIsNotNone(deps.call_kwargs["session_factory"])
            self.assertIsNotNone(deps.call_kwargs["session_factory"])

    def test_run_autonomous_cycle_records_gate_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_autonomy_gates, str(deps.gate_report_path)
            )
            self.assertEqual(scheduler.state.last_autonomy_run_id, "test-run-id")
            self.assertEqual(scheduler.state.last_autonomy_recommendation, "paper")
            self.assertIn("drift_promotion_evidence", deps.call_kwargs)

    def test_run_autonomous_cycle_tracks_promotion_and_throughput_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            deps.gate_payload = {
                "recommended_mode": "paper",
                "gates": [],
                "promotion_recommendation": {
                    "action": "promote",
                    "eligible": True,
                    "trace_id": "rec-trace-123",
                },
                "throughput": {
                    "signal_count": 9,
                    "decision_count": 7,
                    "trade_count": 3,
                    "fold_metrics_count": 1,
                    "stress_metrics_count": 4,
                    "no_signal_window": False,
                    "no_signal_reason": None,
                },
                "promotion_decision": {
                    "promotion_allowed": True,
                    "recommended_mode": "paper",
                    "reason_codes": [],
                },
            }
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.last_autonomy_promotion_action, "promote")
            self.assertTrue(scheduler.state.last_autonomy_promotion_eligible)
            self.assertEqual(
                scheduler.state.last_autonomy_recommendation_trace_id, "rec-trace-123"
            )
            self.assertEqual(scheduler.state.metrics.autonomy_promotions_total, 1)
            self.assertEqual(scheduler.state.metrics.autonomy_last_signal_count, 9)
            self.assertEqual(scheduler.state.metrics.autonomy_last_decision_count, 7)
            self.assertEqual(scheduler.state.metrics.autonomy_last_trade_count, 3)
            self.assertEqual(
                scheduler.state.metrics.autonomy_last_fold_metrics_count, 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_last_stress_metrics_count, 4
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_signal_throughput_total, 9
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_decision_throughput_total, 7
            )
            self.assertEqual(scheduler.state.metrics.autonomy_trade_throughput_total, 3)
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_allowed_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_blocked_total, 0
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_recommendation_total.get("paper"), 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_outcome_total.get("promoted_paper"), 1
            )

    def test_run_autonomous_cycle_records_ingest_reason_when_no_signals(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="cursor_ahead_of_stream",
            )
            with patch(
                "app.trading.scheduler.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ) as persist_no_signal:
                with patch(
                    "app.trading.scheduler.run_autonomous_lane",
                    side_effect=RuntimeError("should_not_run"),
                ):
                    scheduler._run_autonomous_cycle()

            persist_no_signal.assert_called_once()
            args = persist_no_signal.call_args.kwargs
            self.assertEqual(args["no_signal_reason"], "cursor_ahead_of_stream")
            self.assertIsNotNone(args["query_start"])
            self.assertIsNotNone(args["query_end"])

            self.assertEqual(
                scheduler.state.last_ingest_reason, "cursor_ahead_of_stream"
            )
            self.assertEqual(
                scheduler.state.last_autonomy_reason, "cursor_ahead_of_stream"
            )
            self.assertEqual(scheduler.state.last_autonomy_run_id, "no-signal-run-id")
            self.assertIn("no-signals.json", scheduler.state.last_autonomy_gates or "")
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_blocked_total,
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_recommendation_total.get("shadow"),
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_outcome_total.get("skipped_no_signal"),
                1,
            )

    def test_run_autonomous_cycle_updates_ingest_metadata_on_signal_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            stale_time = datetime(2020, 1, 1, tzinfo=timezone.utc)
            scheduler.state.last_ingest_window_start = stale_time
            scheduler.state.last_ingest_window_end = stale_time
            scheduler.state.last_ingest_reason = "stale-no-signal"

            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertIsNone(scheduler.state.last_ingest_reason)
            assert scheduler.state.last_ingest_window_start is not None
            assert scheduler.state.last_ingest_window_end is not None
            self.assertGreater(scheduler.state.last_ingest_window_start, stale_time)
            self.assertGreater(scheduler.state.last_ingest_window_end, stale_time)
            self.assertEqual(scheduler.state.last_ingest_signals_total, 1)
            self.assertEqual(scheduler.state.autonomy_signals_total, 1)

    def test_run_autonomous_cycle_alerts_on_repeated_no_signal_reasons(self) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 2
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="cursor_ahead_of_stream",
            )
            with patch(
                "app.trading.scheduler.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak,
                {"cursor_ahead_of_stream": 1},
            )
            self.assertIsNone(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "cursor_ahead_of_stream"
                ),
            )

            with patch(
                "app.trading.scheduler.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak,
                {"cursor_ahead_of_stream": 2},
            )
            self.assertEqual(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "cursor_ahead_of_stream"
                ),
                1,
            )

    def test_run_autonomous_cycle_alerts_on_signal_lag(self) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 99
        settings.trading_signal_stale_lag_alert_seconds = 30
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="empty_batch_advanced",
                no_signal_lag_seconds=61.2,
            )
            with patch(
                "app.trading.scheduler.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.metrics.signal_lag_seconds, 61)
            self.assertEqual(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "empty_batch_advanced"
                ),
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak.get(
                    "empty_batch_advanced"
                ),
                1,
            )

    def test_run_autonomous_cycle_treats_market_closed_no_signal_as_expected(
        self,
    ) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 1
        settings.trading_signal_stale_lag_alert_seconds = 30
        settings.trading_signal_market_closed_expected_reasons_raw = (
            "no_signals_in_window,cursor_tail_stable,empty_batch_advanced"
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="empty_batch_advanced",
                no_signal_lag_seconds=120.0,
                market_session_open=False,
            )
            with patch(
                "app.trading.scheduler.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_signal_continuity_state,
                "expected_market_closed_staleness",
            )
            self.assertFalse(bool(scheduler.state.last_signal_continuity_actionable))
            self.assertEqual(
                scheduler.state.metrics.signal_expected_staleness_total.get(
                    "empty_batch_advanced"
                ),
                1,
            )
            self.assertIsNone(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "empty_batch_advanced"
                )
            )

    def test_run_autonomous_cycle_records_error_on_lane_exception(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=RuntimeError("lane_failed"),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_autonomy_reason, "lane_execution_failed"
            )
            self.assertEqual(scheduler.state.last_autonomy_error, "lane_failed")
            self.assertIsNone(scheduler.state.last_autonomy_run_id)

    def test_run_evidence_continuity_check_updates_scheduler_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_evidence_continuity_run_limit = 3
            with patch(
                "app.trading.scheduler.evaluate_evidence_continuity"
            ) as mock_check:
                mock_check.return_value = SimpleNamespace(
                    checked_at=datetime(2026, 2, 19, 1, 0, tzinfo=timezone.utc),
                    checked_runs=2,
                    failed_runs=1,
                    run_ids=["run-1", "run-2"],
                    to_payload=lambda: {
                        "checked_runs": 2,
                        "failed_runs": 1,
                        "ok": False,
                    },
                )
                scheduler._run_evidence_continuity_check()

            mock_check.assert_called_once()
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_checks_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_failures_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_last_failed_runs, 1
            )
            self.assertEqual(
                scheduler.state.last_evidence_continuity_report,
                {"checked_runs": 2, "failed_runs": 1, "ok": False},
            )

    def test_safety_controls_trigger_emergency_stop_on_critical_staleness_streak(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_emergency_stop_enabled = True
            settings.trading_rollback_signal_staleness_alert_streak_limit = 2
            settings.trading_signal_staleness_alert_critical_reasons_raw = (
                "cursor_ahead_of_stream"
            )
            scheduler.state.metrics.no_signal_reason_streak = {
                "cursor_ahead_of_stream": 2
            }
            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIsNotNone(scheduler.state.rollback_incident_evidence_path)
            self.assertIn(
                "signal_staleness_streak_exceeded:cursor_ahead_of_stream:2",
                scheduler.state.emergency_stop_reason or "",
            )

    def test_safety_controls_trigger_emergency_stop_when_universe_unavailable(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_emergency_stop_enabled = True
            settings.trading_universe_source = "jangar"
            scheduler.state.universe_source_status = "unavailable"
            scheduler.state.universe_source_reason = "jangar_symbols_fetch_failed"

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn(
                "universe_source_unavailable:unavailable:jangar_symbols_fetch_failed",
                scheduler.state.emergency_stop_reason or "",
            )

    def test_emergency_stop_incident_contains_hooks_and_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-123",
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-1",
                            "recommendation_trace_id": "rec-trace-1",
                        },
                    },
                ),
                encoding="utf-8",
            )
            scheduler.state.last_autonomy_gates = str(gate_path)
            scheduler.state.metrics.no_signal_reason_streak = {
                "cursor_ahead_of_stream": 3
            }
            scheduler.state.metrics.signal_staleness_alert_total = {
                "cursor_ahead_of_stream": 2
            }

            scheduler._trigger_emergency_stop(
                reasons=["signal_staleness_streak_exceeded:cursor_ahead_of_stream:3"],
                fallback_ratio=0.0,
                drawdown=None,
            )

            incident_path = Path(scheduler.state.rollback_incident_evidence_path or "")
            self.assertTrue(incident_path.exists())
            payload = json.loads(incident_path.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["provenance"]["gate_report_trace_id"], "gate-trace-1"
            )
            self.assertEqual(
                payload["provenance"]["recommendation_trace_id"], "rec-trace-1"
            )
            self.assertTrue(payload["rollback_hooks"]["order_submission_blocked"])
            self.assertTrue(payload["verification"]["incident_evidence_complete"])

    def test_drift_governance_triggers_rollback_on_performance_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_drift_rollback_on_performance = True
            settings.trading_emergency_stop_enabled = True
            settings.trading_drift_rollback_reason_codes_raw = (
                "performance_drawdown_exceeded"
            )
            settings.trading_drift_max_performance_drawdown = 0.01
            deps.gate_payload = {
                "recommended_mode": "paper",
                "gates": [],
                "metrics": {"max_drawdown": "0.25"},
            }
            with patch(
                "app.trading.scheduler.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn(
                "drift_reason_detected:performance_drawdown_exceeded",
                scheduler.state.emergency_stop_reason or "",
            )
            self.assertIsNotNone(scheduler.state.rollback_incident_evidence_path)

    def _build_scheduler_with_fixtures(
        self,
        tmpdir: str,
        *,
        allow_live: bool,
        approval_token: str | None,
        no_signals: bool = False,
        no_signal_reason: str | None = None,
        no_signal_lag_seconds: float | None = None,
        market_session_open: bool = True,
    ) -> tuple[TradingScheduler, _SchedulerDependencies]:
        strategy_config_path = Path(tmpdir) / "strategies.yaml"
        strategy_config_path.write_text(
            json.dumps(
                {
                    "strategies": [
                        {
                            "strategy_id": "intraday-tsmom-profit-v2",
                            "strategy_type": "intraday_tsmom_v1",
                            "version": "1.1.0",
                            "enabled": True,
                            "base_timeframe": "1Min",
                        }
                    ]
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        gate_policy_path = Path(tmpdir) / "autonomy-gates-v3.json"
        gate_policy_path.write_text(
            json.dumps(
                {
                    "policy_version": "v3-gates-1",
                    "required_feature_schema_version": "3.0.0",
                    "gate1_min_decision_count": 0,
                    "gate1_min_trade_count": 0,
                    "gate1_min_net_pnl": "-1",
                    "gate1_max_negative_fold_ratio": "1",
                    "gate1_max_net_pnl_cv": "100",
                    "gate2_max_drawdown": "100000",
                    "gate2_max_turnover_ratio": "1000",
                    "gate2_max_cost_bps": "1000",
                    "gate3_max_llm_error_ratio": "1",
                    "gate5_live_enabled": True,
                    "gate5_require_approval_token": True,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        settings.trading_autonomy_allow_live_promotion = allow_live
        settings.trading_autonomy_approval_token = approval_token
        settings.trading_strategy_config_path = str(strategy_config_path)
        settings.trading_autonomy_gate_policy_path = str(gate_policy_path)
        settings.trading_autonomy_artifact_dir = str(
            Path(tmpdir) / "autonomy-artifacts"
        )
        settings.trading_universe_source = "jangar"
        settings.trading_drift_governance_enabled = True
        settings.trading_drift_live_promotion_requires_evidence = True
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 1800
        settings.trading_drift_rollback_on_performance = True

        scheduler = TradingScheduler()

        @contextmanager
        def _session_factory():
            yield None

        scheduler._pipeline = _PipelineStub(
            signals=[] if no_signals else _signal_batch(),
            session_factory=_session_factory,
            no_signal_reason=no_signal_reason,
            no_signal_lag_seconds=no_signal_lag_seconds,
            market_session_open=market_session_open,
            state=scheduler.state,
        )

        return scheduler, _SchedulerDependencies()

    @staticmethod
    def _fake_run_autonomous_lane(deps: _SchedulerDependencies):
        def _capture(
            *,
            signals_path: Path,
            strategy_config_path: Path,
            gate_policy_path: Path,
            output_dir: Path,
            **kwargs: Any,
        ) -> SimpleNamespace:
            deps.call_kwargs = kwargs
            deps.call_kwargs["strategy_config_path"] = strategy_config_path
            deps.call_kwargs["gate_policy_path"] = gate_policy_path

            deps.call_kwargs.update(
                {
                    "strategy_config_path": strategy_config_path,
                    "gate_policy_path": gate_policy_path,
                    "promotion_target": kwargs.get("promotion_target"),
                    "approval_token": kwargs.get("approval_token"),
                }
            )

            gate_report_path = output_dir / "gate-evaluation.json"
            gate_payload = deps.gate_payload or {
                "recommended_mode": "paper",
                "gates": [],
                "throughput": {
                    "signal_count": 8,
                    "decision_count": 5,
                    "trade_count": 3,
                    "fold_metrics_count": 1,
                    "stress_metrics_count": 4,
                },
                "promotion_decision": {
                    "promotion_allowed": True,
                    "recommended_mode": "paper",
                },
            }
            gate_report_path.write_text(json.dumps(gate_payload), encoding="utf-8")
            deps.gate_report_path = gate_report_path

            return SimpleNamespace(
                run_id="test-run-id",
                candidate_id="cand-test",
                output_dir=output_dir,
                gate_report_path=gate_report_path,
                paper_patch_path=None,
            )

        return _capture
