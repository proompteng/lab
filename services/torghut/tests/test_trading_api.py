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
from app.models import (
    Base,
    Execution,
    ExecutionTCAMetric,
    LLMDecisionReview,
    Strategy,
    TradeDecision,
)


class TestTradingApi(TestCase):
    def setUp(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )

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
            session.commit()
            session.refresh(execution)

            tca = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=decision.id,
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                arrival_price=Decimal("100"),
                avg_fill_price=Decimal("101"),
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                slippage_bps=Decimal("100"),
                shortfall_notional=Decimal("1"),
                churn_qty=Decimal("0"),
                churn_ratio=Decimal("0"),
            )
            session.add(tca)
            session.commit()

            review = LLMDecisionReview(
                trade_decision_id=decision.id,
                model="demo",
                prompt_version="v1",
                input_json={"decision": "demo"},
                response_json={"verdict": "approve"},
                verdict="approve",
                confidence=Decimal("0.7"),
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale="ok",
                risk_flags=["demo_flag"],
                tokens_prompt=120,
                tokens_completion=45,
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
        self.assertIsNotNone(payload[0]["tca"])
        self.assertEqual(payload[0]["tca"]["slippage_bps"], 100.0)

    def test_trading_tca_endpoint(self) -> None:
        response = self.client.get("/trading/tca?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["summary"]["order_count"], 1)
        self.assertEqual(len(payload["rows"]), 1)
        self.assertEqual(payload["rows"][0]["symbol"], "AAPL")

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    def test_trading_health_ok(
        self, _mock_clickhouse: object, _mock_alpaca: object
    ) -> None:
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
    def test_trading_health_dependency_failure(
        self, _mock_clickhouse: object, _mock_alpaca: object
    ) -> None:
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

    def test_trading_status_includes_llm_evaluation(self) -> None:
        response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("llm_evaluation", payload)
        self.assertIn("control_plane_contract", payload)
        evaluation = payload["llm_evaluation"]
        self.assertTrue(evaluation["ok"])
        self.assertGreaterEqual(evaluation["metrics"]["total_reviews"], 1)
        control_plane_contract = payload["control_plane_contract"]
        self.assertEqual(
            control_plane_contract["contract_version"], "torghut.quant-producer.v1"
        )
        self.assertIn("signal_lag_seconds", control_plane_contract)

    def test_trading_metrics_includes_control_plane_contract(self) -> None:
        response = self.client.get("/trading/metrics")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("control_plane_contract", payload)
        self.assertEqual(
            payload["control_plane_contract"]["contract_version"],
            "torghut.quant-producer.v1",
        )

    def test_trading_status_includes_signal_ingest_metadata(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.last_ingest_reason = "cursor_ahead_of_stream"
            scheduler.state.last_ingest_signals_total = 0
            scheduler.state.autonomy_no_signal_streak = 4
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            autonomy = payload["autonomy"]
            self.assertEqual(autonomy["last_ingest_signal_count"], 0)
            self.assertEqual(autonomy["last_ingest_reason"], "cursor_ahead_of_stream")
            self.assertEqual(autonomy["no_signal_streak"], 4)
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_includes_no_signal_streak(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.autonomy_no_signal_streak = 7
            scheduler.state.last_autonomy_reason = "cursor_ahead_of_stream"
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/autonomy")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["no_signal_streak"], 7)
            self.assertEqual(payload["last_reason"], "cursor_ahead_of_stream")
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_evidence_continuity_endpoint_returns_state_report(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.last_evidence_continuity_report = {
                "checked_runs": 2,
                "failed_runs": 0,
                "ok": True,
            }
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/autonomy/evidence-continuity")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertIn("report", payload)
            self.assertEqual(payload["report"]["checked_runs"], 2)
            self.assertEqual(payload["report"]["failed_runs"], 0)
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_evidence_continuity_endpoint_supports_refresh(self) -> None:
        response = self.client.get("/trading/autonomy/evidence-continuity?refresh=true&run_limit=5")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("report", payload)
        self.assertEqual(payload["report"]["checked_runs"], 0)
        self.assertEqual(payload["report"]["failed_runs"], 0)

    def test_trading_status_reports_effective_llm_guardrails(self) -> None:
        original = {
            "llm_shadow_mode": settings.llm_shadow_mode,
            "llm_enabled": settings.llm_enabled,
            "llm_allowed_models_raw": settings.llm_allowed_models_raw,
            "llm_evaluation_report": settings.llm_evaluation_report,
            "llm_effective_challenge_id": settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": settings.llm_shadow_completed_at,
        }
        settings.llm_enabled = True
        settings.llm_shadow_mode = False
        settings.llm_allowed_models_raw = None
        settings.llm_evaluation_report = None
        settings.llm_effective_challenge_id = None
        settings.llm_shadow_completed_at = None

        try:
            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            llm = payload["llm"]
            self.assertFalse(llm["shadow_mode"])
            self.assertTrue(llm["effective_shadow_mode"])
            self.assertIn("guardrails", llm)
            self.assertTrue(llm["guardrails"]["allow_requests"])
            self.assertIn("llm_evaluation_report_missing", llm["guardrails"]["reasons"])
        finally:
            settings.llm_shadow_mode = original["llm_shadow_mode"]
            settings.llm_enabled = original["llm_enabled"]
            settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            settings.llm_evaluation_report = original["llm_evaluation_report"]
            settings.llm_effective_challenge_id = original["llm_effective_challenge_id"]
            settings.llm_shadow_completed_at = original["llm_shadow_completed_at"]

    def test_trading_llm_evaluation_endpoint(self) -> None:
        response = self.client.get("/trading/llm-evaluation")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        metrics = payload["metrics"]
        self.assertEqual(metrics["tokens"]["prompt"], 120)
        self.assertEqual(metrics["tokens"]["completion"], 45)
