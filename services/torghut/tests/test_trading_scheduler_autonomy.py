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
    state: TradingState | None = None

    def __post_init__(self) -> None:
        self.ingestor = self

    def fetch_signals_between(self, start: datetime, end: datetime) -> list[SignalEnvelope]:
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
        if batch.signal_lag_seconds is not None:
            self.state.metrics.signal_lag_seconds = int(batch.signal_lag_seconds)
        else:
            self.state.metrics.signal_lag_seconds = None
        self.state.metrics.record_no_signal(reason)
        streak = self.state.metrics.no_signal_reason_streak.get(reason or "unknown", 0)
        if reason in {
            "no_signals_in_window",
            "cursor_tail_stable",
            "cursor_ahead_of_stream",
            "empty_batch_advanced",
        } and streak >= settings.trading_signal_no_signal_streak_alert_threshold:
            self.state.metrics.record_signal_staleness_alert(reason)
        elif (
            batch.signal_lag_seconds is not None
            and batch.signal_lag_seconds >= settings.trading_signal_stale_lag_alert_seconds
        ):
            self.state.metrics.record_signal_staleness_alert(reason)


class _SchedulerDependencies:
    def __init__(self) -> None:
        self.call_kwargs: dict[str, Any] = {}


def _signal_batch() -> list[SignalEnvelope]:
    return [
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={"macd": {"macd": "1", "signal": "0"}, "rsi14": "58", "price": "100"},
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
            "trading_evidence_continuity_run_limit": settings.trading_evidence_continuity_run_limit,
        }

    def tearDown(self) -> None:
        settings.trading_autonomy_allow_live_promotion = self._settings_snapshot[
            "trading_autonomy_allow_live_promotion"
        ]
        settings.trading_autonomy_approval_token = self._settings_snapshot["trading_autonomy_approval_token"]
        settings.trading_strategy_config_path = self._settings_snapshot["trading_strategy_config_path"]
        settings.trading_autonomy_gate_policy_path = self._settings_snapshot["trading_autonomy_gate_policy_path"]
        settings.trading_autonomy_artifact_dir = self._settings_snapshot["trading_autonomy_artifact_dir"]
        settings.trading_signal_no_signal_streak_alert_threshold = self._settings_snapshot[
            "trading_signal_no_signal_streak_alert_threshold"
        ]
        settings.trading_signal_stale_lag_alert_seconds = self._settings_snapshot[
            "trading_signal_stale_lag_alert_seconds"
        ]
        settings.trading_evidence_continuity_run_limit = self._settings_snapshot[
            "trading_evidence_continuity_run_limit"
        ]

    def test_run_autonomous_cycle_uses_live_promotion_when_token_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token="live-approve-token",
            )
            with patch("app.trading.scheduler.run_autonomous_lane", side_effect=self._fake_run_autonomous_lane(deps)):
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
            with patch("app.trading.scheduler.run_autonomous_lane", side_effect=self._fake_run_autonomous_lane(deps)):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_falls_back_to_paper_when_live_token_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token=None,
            )
            with patch("app.trading.scheduler.run_autonomous_lane", side_effect=self._fake_run_autonomous_lane(deps)):
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
            with patch("app.trading.scheduler.run_autonomous_lane", side_effect=self._fake_run_autonomous_lane(deps)):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["strategy_config_path"], Path(settings.trading_strategy_config_path))
            self.assertEqual(deps.call_kwargs["gate_policy_path"], Path(settings.trading_autonomy_gate_policy_path))

    def test_run_autonomous_cycle_passes_persistence_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch("app.trading.scheduler.run_autonomous_lane", side_effect=self._fake_run_autonomous_lane(deps)):
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
            with patch("app.trading.scheduler.run_autonomous_lane", side_effect=self._fake_run_autonomous_lane(deps)):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.last_autonomy_gates, str(deps.gate_report_path))
            self.assertEqual(scheduler.state.last_autonomy_run_id, "test-run-id")
            self.assertEqual(scheduler.state.last_autonomy_recommendation, "paper")

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
                with patch("app.trading.scheduler.run_autonomous_lane", side_effect=RuntimeError("should_not_run")):
                    scheduler._run_autonomous_cycle()

            persist_no_signal.assert_called_once()
            args = persist_no_signal.call_args.kwargs
            self.assertEqual(args["no_signal_reason"], "cursor_ahead_of_stream")
            self.assertIsNotNone(args["query_start"])
            self.assertIsNotNone(args["query_end"])

            self.assertEqual(scheduler.state.last_ingest_reason, "cursor_ahead_of_stream")
            self.assertEqual(scheduler.state.last_autonomy_reason, "cursor_ahead_of_stream")
            self.assertEqual(scheduler.state.last_autonomy_run_id, "no-signal-run-id")
            self.assertIn("no-signals.json", scheduler.state.last_autonomy_gates or "")

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

            with patch("app.trading.scheduler.run_autonomous_lane", side_effect=self._fake_run_autonomous_lane(deps)):
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
            with patch("app.trading.scheduler.upsert_autonomy_no_signal_run", return_value="no-signal-run-id"):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.metrics.no_signal_reason_streak, {"cursor_ahead_of_stream": 1})
            self.assertIsNone(
                scheduler.state.metrics.signal_staleness_alert_total.get("cursor_ahead_of_stream"),
            )

            with patch("app.trading.scheduler.upsert_autonomy_no_signal_run", return_value="no-signal-run-id"):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.metrics.no_signal_reason_streak, {"cursor_ahead_of_stream": 2})
            self.assertEqual(
                scheduler.state.metrics.signal_staleness_alert_total.get("cursor_ahead_of_stream"),
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
            with patch("app.trading.scheduler.upsert_autonomy_no_signal_run", return_value="no-signal-run-id"):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.metrics.signal_lag_seconds, 61)
            self.assertEqual(
                scheduler.state.metrics.signal_staleness_alert_total.get("empty_batch_advanced"),
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak.get("empty_batch_advanced"),
                1,
            )

    def test_run_autonomous_cycle_records_error_on_lane_exception(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch("app.trading.scheduler.run_autonomous_lane", side_effect=RuntimeError("lane_failed")):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.last_autonomy_reason, "lane_execution_failed")
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
            with patch("app.trading.scheduler.evaluate_evidence_continuity") as mock_check:
                mock_check.return_value = SimpleNamespace(
                    checked_at=datetime(2026, 2, 19, 1, 0, tzinfo=timezone.utc),
                    checked_runs=2,
                    failed_runs=1,
                    run_ids=["run-1", "run-2"],
                    to_payload=lambda: {"checked_runs": 2, "failed_runs": 1, "ok": False},
                )
                scheduler._run_evidence_continuity_check()

            mock_check.assert_called_once()
            self.assertEqual(scheduler.state.metrics.evidence_continuity_checks_total, 1)
            self.assertEqual(scheduler.state.metrics.evidence_continuity_failures_total, 1)
            self.assertEqual(scheduler.state.metrics.evidence_continuity_last_failed_runs, 1)
            self.assertEqual(
                scheduler.state.last_evidence_continuity_report,
                {"checked_runs": 2, "failed_runs": 1, "ok": False},
            )

    def _build_scheduler_with_fixtures(
        self,
        tmpdir: str,
        *,
        allow_live: bool,
        approval_token: str | None,
        no_signals: bool = False,
        no_signal_reason: str | None = None,
        no_signal_lag_seconds: float | None = None,
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
        settings.trading_autonomy_artifact_dir = str(Path(tmpdir) / "autonomy-artifacts")

        scheduler = TradingScheduler()
        @contextmanager
        def _session_factory():
            yield None

        scheduler._pipeline = _PipelineStub(
            signals=[] if no_signals else _signal_batch(),
            session_factory=_session_factory,
            no_signal_reason=no_signal_reason,
            no_signal_lag_seconds=no_signal_lag_seconds,
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
            gate_report_path.write_text('{"recommended_mode": "paper", "gates": []}', encoding='utf-8')
            deps.gate_report_path = gate_report_path

            return SimpleNamespace(
                run_id="test-run-id",
                candidate_id="cand-test",
                output_dir=output_dir,
                gate_report_path=gate_report_path,
                paper_patch_path=None,
            )

        return _capture
