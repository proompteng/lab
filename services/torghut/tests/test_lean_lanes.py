from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base, LeanStrategyShadowEvaluation
from app.trading.lean_runtime import SCAFFOLD_BLOCKED_STATUS
from app.trading.lean_lanes import LeanLaneManager


class TestLeanLanes(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

    def test_submit_and_refresh_backtest_persist_repro_metadata(self) -> None:
        manager = LeanLaneManager()
        with (
            patch(
                "app.trading.lean_lanes.submit_backtest",
                return_value={
                    "backtest_id": "bt-1",
                    "status": "queued",
                    "reproducibility_hash": "abc123",
                },
            ),
            patch(
                "app.trading.lean_lanes.get_backtest",
                return_value={
                    "backtest_id": "bt-1",
                    "status": "completed",
                    "result": {
                        "replay_hash": "xyz789",
                        "deterministic_replay_passed": True,
                        "artifacts": {"report_uri": "s3://test/report.json"},
                    },
                },
            ),
        ):
            with self.SessionLocal() as session:
                row = manager.submit_backtest(
                    session,
                    config={"symbol": "BTC/USD"},
                    lane="research",
                    requested_by="quant",
                    correlation_id="corr-1",
                )
                self.assertEqual(row.backtest_id, "bt-1")
                self.assertEqual(row.reproducibility_hash, "abc123")

                refreshed = manager.refresh_backtest(session, backtest_id="bt-1")
                self.assertEqual(refreshed.status, "completed")
                self.assertEqual(refreshed.replay_hash, "xyz789")
                self.assertTrue(refreshed.deterministic_replay_passed)
                self.assertIsNotNone(refreshed.completed_at)

    def test_shadow_parity_status_columns_allow_scaffold_blocked_status(self) -> None:
        required_length = len(SCAFFOLD_BLOCKED_STATUS)
        self.assertGreaterEqual(
            LeanStrategyShadowEvaluation.__table__.c.parity_status.type.length,
            required_length,
        )

    def test_record_strategy_shadow_rolls_back_on_commit_error(self) -> None:
        manager = LeanLaneManager()

        with self.SessionLocal() as session:
            with patch.object(session, "commit", side_effect=RuntimeError("boom")):
                with patch.object(session, "rollback") as rollback_mock:
                    with self.assertRaisesRegex(RuntimeError, "boom"):
                        manager.record_strategy_shadow(
                            session,
                            strategy_id="strategy-1",
                            symbol="AAPL",
                            intent={"action": "buy", "qty": "1"},
                            shadow_result={
                                "run_id": "run-1",
                                "parity_status": SCAFFOLD_BLOCKED_STATUS,
                                "governance": {},
                            },
                        )
                rollback_mock.assert_called_once()
