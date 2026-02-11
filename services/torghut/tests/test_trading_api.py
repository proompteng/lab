from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session, sessionmaker

from app.db import get_session
from app.main import app
from app.trading.scheduler import TradingScheduler
from app.config import settings
from app.models import Base, Execution, LLMDecisionReview, Strategy, TradeDecision


class TestTradingApi(TestCase):
    def setUp(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        def _override_session() -> Session:
            with self.session_local() as session:
                yield session

        app.dependency_overrides[get_session] = _override_session
        self.client = TestClient(app)

        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"action": "buy", "qty": "1", "params": {"price": "100"}},
                rationale="demo",
                status="planned",
                created_at=datetime.now(timezone.utc),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)

            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id="order-1",
                client_order_id="client-1",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                avg_fill_price=None,
                status="accepted",
                raw_order={},
                last_update_at=datetime.now(timezone.utc),
            )
            session.add(execution)
            review = LLMDecisionReview(
                trade_decision_id=decision.id,
                model="gpt-test",
                prompt_version="v1",
                input_json={"decision": {"action": "buy"}},
                response_json={"verdict": "approve"},
                verdict="approve",
                confidence=Decimal("0.9"),
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale="ok",
                risk_flags=["review"],
                tokens_prompt=12,
                tokens_completion=18,
                created_at=datetime.now(timezone.utc),
            )
            session.add(review)
            session.commit()

    def tearDown(self) -> None:
        app.dependency_overrides.clear()

    def test_trading_decisions_endpoint(self) -> None:
        response = self.client.get("/trading/decisions?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["symbol"], "AAPL")

    def test_trading_executions_endpoint(self) -> None:
        response = self.client.get("/trading/executions?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["symbol"], "AAPL")

    def test_trading_llm_evaluation_endpoint(self) -> None:
        response = self.client.get("/trading/llm-evaluation")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["totals"]["reviews"], 1)
        self.assertEqual(payload["totals"]["errors"], 0)
        self.assertEqual(payload["verdict_counts"]["approve"], 1)
        self.assertEqual(payload["totals"]["tokens_prompt"], 12)
        self.assertEqual(payload["totals"]["tokens_completion"], 18)
        self.assertEqual(payload["top_risk_flags"][0]["flag"], "review")

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    def test_trading_health_ok(self, _mock_clickhouse: object, _mock_alpaca: object) -> None:
        original = settings.trading_enabled
        settings.trading_enabled = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["postgres"]["ok"])
            self.assertTrue(payload["dependencies"]["clickhouse"]["ok"])
            self.assertTrue(payload["dependencies"]["alpaca"]["ok"])
        finally:
            settings.trading_enabled = original

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": False, "detail": "down"})
    def test_trading_health_dependency_failure(self, _mock_clickhouse: object, _mock_alpaca: object) -> None:
        original = settings.trading_enabled
        settings.trading_enabled = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["clickhouse"]["ok"])
        finally:
            settings.trading_enabled = original
