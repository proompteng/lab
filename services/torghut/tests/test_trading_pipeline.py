from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, Strategy, TradeDecision, Execution
from app.trading.decisions import DecisionEngine
from app.trading.execution import OrderExecutor
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.risk import RiskEngine
from app.trading.scheduler import TradingPipeline, TradingState
from app.trading.reconcile import Reconciler
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


@pytest.fixture()
def session_factory():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def test_decision_engine_macd_rsi() -> None:
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
    assert decisions
    assert decisions[0].action == "buy"


def test_risk_engine_rejects_live_trading(monkeypatch, session_factory) -> None:
    from app import config

    monkeypatch.setattr(config.settings, "trading_enabled", True)
    monkeypatch.setattr(config.settings, "trading_mode", "live")
    monkeypatch.setattr(config.settings, "trading_live_enabled", False)

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

    with session_factory() as session:
        engine = RiskEngine()
        verdict = engine.evaluate(
            session,
            decision,
            strategy,
            account={"equity": "10000", "buying_power": "10000"},
            positions=[],
            allowed_symbols={"AAPL"},
        )
        assert not verdict.approved
        assert "live_trading_disabled" in verdict.reasons


def test_pipeline_idempotent_execution(monkeypatch, session_factory) -> None:
    from app import config

    monkeypatch.setattr(config.settings, "trading_enabled", True)
    monkeypatch.setattr(config.settings, "trading_mode", "paper")
    monkeypatch.setattr(config.settings, "trading_live_enabled", False)
    monkeypatch.setattr(config.settings, "trading_universe_source", "static")
    monkeypatch.setattr(config.settings, "trading_static_symbols_raw", "AAPL")

    session_local = session_factory
    with session_local() as session:
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
        session_factory=session_local,
    )

    pipeline.run_once()
    pipeline.run_once()

    with session_local() as session:
        decisions = session.execute(select(TradeDecision)).scalars().all()
        executions = session.execute(select(Execution)).scalars().all()
        assert len(decisions) == 1
        assert len(executions) == 1
        assert decisions[0].decision_hash is not None
