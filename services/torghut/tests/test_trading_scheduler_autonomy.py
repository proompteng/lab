from __future__ import annotations

import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.trading.models import SignalEnvelope
from app.trading.scheduler import TradingScheduler


@dataclass
class _PipelineStub:
    signals: list[SignalEnvelope]
    session_factory: object

    def __post_init__(self) -> None:
        self.ingestor = self

    def fetch_signals_between(self, start: datetime, end: datetime) -> list[SignalEnvelope]:
        return list(self.signals)


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
        }

    def tearDown(self) -> None:
        settings.trading_autonomy_allow_live_promotion = self._settings_snapshot["trading_autonomy_allow_live_promotion"]
        settings.trading_autonomy_approval_token = self._settings_snapshot["trading_autonomy_approval_token"]
        settings.trading_strategy_config_path = self._settings_snapshot["trading_strategy_config_path"]
        settings.trading_autonomy_gate_policy_path = self._settings_snapshot["trading_autonomy_gate_policy_path"]
        settings.trading_autonomy_artifact_dir = self._settings_snapshot["trading_autonomy_artifact_dir"]

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

    def _build_scheduler_with_fixtures(
        self,
        tmpdir: str,
        *,
        allow_live: bool,
        approval_token: str | None,
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
        scheduler._pipeline = _PipelineStub(signals=_signal_batch(), session_factory=lambda: None)

        return scheduler, _SchedulerDependencies()

    @staticmethod
    def _fake_run_autonomous_lane(deps: _SchedulerDependencies):
        def _capture(*, signals_path: Path, strategy_config_path: Path, gate_policy_path: Path, output_dir: Path, **kwargs: Any) -> SimpleNamespace:
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
