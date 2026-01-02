from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, Execution, LLMDecisionReview, Strategy, TradeDecision
from app.trading.decisions import DecisionEngine
from app.trading.execution import OrderExecutor
from app.trading.llm.review_engine import LLMReviewOutcome
from app.trading.llm.schema import (
    LLMDecisionContext,
    LLMPolicyContext,
    MarketSnapshot,
    PortfolioSnapshot,
    RecentDecisionSummary,
    LLMReviewRequest,
    LLMReviewResponse,
)
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.prices import PriceFetcher
from app.trading.reconcile import Reconciler
from app.trading.risk import RiskEngine
from app.trading.scheduler import TradingPipeline, TradingState
from app.trading.universe import UniverseResolver


class FakeIngestor:
    def __init__(self, signals: list[SignalEnvelope]) -> None:
        self.signals = signals

    def fetch_signals(self, session: Session) -> list[SignalEnvelope]:
        return self.signals


class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submitted: list[dict[str, str]] = []

    def get_account(self) -> dict[str, str]:
        return {"equity": "10000", "cash": "10000", "buying_power": "10000"}

    def list_positions(self) -> list[dict[str, str]]:
        return []

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, str] | None = None,
    ) -> dict[str, str]:
        order = {
            "id": f"order-{len(self.submitted) + 1}",
            "client_order_id": extra_params.get("client_order_id") if extra_params else None,
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
            "qty": str(qty),
            "filled_qty": "0",
            "status": "accepted",
        }
        self.submitted.append(order)
        return order

    def get_order(self, alpaca_order_id: str) -> dict[str, str]:
        return {
            "id": alpaca_order_id,
            "status": "filled",
            "filled_qty": "1",
            "filled_avg_price": "100",
        }


class FakeLLMReviewEngine:
    def __init__(
        self,
        verdict: str = "approve",
        adjusted_qty: Decimal | None = None,
        adjusted_order_type: str | None = None,
        confidence: float = 0.9,
        error: Exception | None = None,
        circuit_open: bool = False,
    ) -> None:
        self.verdict = verdict
        self.adjusted_qty = adjusted_qty
        self.adjusted_order_type = adjusted_order_type
        self.confidence = confidence
        self.error = error
        self.circuit_breaker = FakeCircuitBreaker(circuit_open)

    def build_request(
        self,
        decision: StrategyDecision,
        account: dict[str, str],
        positions: list[dict[str, str]],
        portfolio: PortfolioSnapshot | None = None,
        market: MarketSnapshot | None = None,
        recent_decisions: list[RecentDecisionSummary] | None = None,
    ) -> LLMReviewRequest:
        portfolio_snapshot = portfolio or PortfolioSnapshot(
            equity=Decimal("10000"),
            cash=Decimal("10000"),
            buying_power=Decimal("10000"),
            total_exposure=Decimal("0"),
            exposure_by_symbol={},
            positions=positions,
        )
        return LLMReviewRequest(
            decision=LLMDecisionContext(
                strategy_id=decision.strategy_id,
                symbol=decision.symbol,
                action=decision.action,
                qty=decision.qty,
                order_type=decision.order_type,
                time_in_force=decision.time_in_force,
                event_ts=decision.event_ts,
                timeframe=decision.timeframe,
                rationale=decision.rationale,
                params=decision.params,
            ),
            portfolio=portfolio_snapshot,
            market=market,
            recent_decisions=recent_decisions or [],
            account=account,
            positions=positions,
            policy=LLMPolicyContext(
                adjustment_allowed=True,
                min_qty_multiplier=Decimal("0.5"),
                max_qty_multiplier=Decimal("1.25"),
                allowed_order_types=["limit", "market"],
            ),
            trading_mode="paper",
            prompt_version="test",
        )

    def review(
        self,
        decision: StrategyDecision,
        account: dict[str, str],
        positions: list[dict[str, str]],
        request: LLMReviewRequest | None = None,
        portfolio: PortfolioSnapshot | None = None,
        market: MarketSnapshot | None = None,
        recent_decisions: list[RecentDecisionSummary] | None = None,
    ) -> LLMReviewOutcome:
        if self.error:
            raise self.error
        request = request or self.build_request(
            decision,
            account,
            positions,
            portfolio=portfolio,
            market=market,
            recent_decisions=recent_decisions,
        )
        response = LLMReviewResponse(
            verdict=self.verdict,
            confidence=self.confidence,
            adjusted_qty=self.adjusted_qty,
            adjusted_order_type=self.adjusted_order_type,
            rationale="ok",
            risk_flags=[],
        )
        return LLMReviewOutcome(
            request_json=request.model_dump(mode="json"),
            response_json=response.model_dump(mode="json"),
            response=response,
            model="test-model",
            prompt_version="test",
            tokens_prompt=12,
            tokens_completion=7,
        )


class FakePriceFetcher(PriceFetcher):
    def __init__(self, price: Decimal) -> None:
        self.price = price

    def fetch_price(self, signal: SignalEnvelope) -> Decimal:
        return self.price


class FakeCircuitBreaker:
    def __init__(self, open_state: bool = False) -> None:
        self.open_state = open_state

    def is_open(self) -> bool:
        return self.open_state

    def record_error(self) -> None:
        return None

    def record_success(self) -> None:
        return None


class TestTradingPipeline(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def test_decision_engine_macd_rsi(self) -> None:
        engine = DecisionEngine()
        strategy = Strategy(
            name="demo",
            description="demo",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        signal = SignalEnvelope(
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            payload={"macd": {"macd": 1.2, "signal": 0.5}, "rsi14": 25, "price": 100},
            timeframe="1Min",
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertTrue(decisions)
        self.assertEqual(decisions[0].action, "buy")

    def test_decision_engine_attaches_price(self) -> None:
        engine = DecisionEngine(price_fetcher=FakePriceFetcher(Decimal("101.5")))
        strategy = Strategy(
            name="demo",
            description="demo",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        signal = SignalEnvelope(
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            payload={"macd": {"macd": 1.2, "signal": 0.5}, "rsi14": 25},
            timeframe="1Min",
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertTrue(decisions)
        self.assertEqual(decisions[0].params.get("price"), Decimal("101.5"))

    def test_risk_engine_rejects_live_trading(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = False

        try:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )

            with self.session_local() as session:
                engine = RiskEngine()
                verdict = engine.evaluate(
                    session,
                    decision,
                    strategy,
                    account={"equity": "10000", "buying_power": "10000"},
                    positions=[],
                    allowed_symbols={"AAPL"},
                )
            self.assertFalse(verdict.approved)
            self.assertIn("live_trading_disabled", verdict.reasons)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]

    def test_pipeline_idempotent_execution(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()
                session.refresh(strategy)

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()
            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(decisions), 1)
                self.assertEqual(len(executions), 1)
                self.assertIsNotNone(decisions[0].decision_hash)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]

    def test_pipeline_persists_price_snapshot(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                price_fetcher=FakePriceFetcher(Decimal("101.5")),
            )

            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decisions), 1)
                decision_json = decisions[0].decision_json
                params = decision_json.get("params", {})
                self.assertEqual(params.get("price"), "101.5")
                snapshot = params.get("price_snapshot", {})
                self.assertEqual(snapshot.get("price"), "101.5")
                self.assertEqual(snapshot.get("source"), "price_fetcher")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]

    def test_pipeline_llm_approve(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.0

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(verdict="approve"),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "approve")
                self.assertEqual(len(executions), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]

    def test_pipeline_llm_veto(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.0

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(verdict="veto"),
            )

            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "veto")
                self.assertEqual(decisions[0].status, "rejected")
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]

    def test_pipeline_llm_adjust(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_adjustment_allowed = True

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(
                    verdict="adjust",
                    adjusted_qty=Decimal("1.2"),
                    adjusted_order_type="limit",
                ),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(reviews[0].verdict, "adjust")
                self.assertEqual(reviews[0].adjusted_qty, Decimal("1.2"))
                self.assertEqual(len(executions), 1)
                self.assertEqual(executions[0].submitted_qty, Decimal("1.2"))
                decision_json = decisions[0].decision_json
                self.assertIn("llm_adjusted_decision", decision_json)
                self.assertEqual(decision_json["llm_adjusted_decision"]["qty"], "1.2")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]

    def test_pipeline_llm_failure_fallbacks(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
        }
        config.settings.trading_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_min_confidence = 0.0

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            config.settings.trading_mode = "paper"
            config.settings.trading_live_enabled = False
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(error=RuntimeError("boom")),
            )
            pipeline.run_once()

            with self.session_local() as session:
                executions = session.execute(select(Execution)).scalars().all()
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                self.assertEqual(len(executions), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(reviews[0].response_json.get("fallback"), "pass_through")
                self.assertEqual(reviews[0].response_json.get("effective_verdict"), "approve")

            config.settings.trading_mode = "live"
            config.settings.trading_live_enabled = True
            live_signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )
            pipeline_live = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([live_signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(error=RuntimeError("boom")),
            )
            pipeline_live.run_once()

            with self.session_local() as session:
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(executions), 1)
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(decisions[-1].status, "rejected")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]

    def test_pipeline_llm_shadow_mode(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_shadow_mode = True
        config.settings.llm_min_confidence = 0.0

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(verdict="veto"),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "veto")
                self.assertEqual(decisions[0].status, "submitted")
                self.assertEqual(len(executions), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]

    def test_pipeline_llm_circuit_open(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(circuit_open=True),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(len(executions), 1)
                self.assertEqual(pipeline.state.metrics.llm_circuit_open_total, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]

    def test_pipeline_llm_min_confidence(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.9

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(verdict="approve", confidence=0.1),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "veto")
                self.assertEqual(decisions[0].status, "rejected")
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]

    def test_pipeline_llm_adjust_out_of_bounds(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_min_confidence": config.settings.llm_min_confidence,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_adjustment_allowed = True
        config.settings.llm_min_confidence = 0.0

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={"macd": {"macd": 1.1, "signal": 0.4}, "rsi14": 25, "price": 100},
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(
                    verdict="adjust",
                    adjusted_qty=Decimal("10"),
                    adjusted_order_type="limit",
                ),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "veto")
                self.assertEqual(decisions[0].status, "rejected")
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original["trading_universe_source"]
            config.settings.trading_static_symbols_raw = original["trading_static_symbols_raw"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
