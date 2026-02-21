from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import config
from app.models import Base, Strategy, TradeDecision
from app.trading.models import StrategyDecision
from app.trading.risk import RiskEngine


class TestRiskEngine(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )
        self.risk_engine = RiskEngine()
        self.strategy = Strategy(
            name="test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=Decimal("0.5"),
            max_notional_per_trade=Decimal("20000"),
        )
        self._original_allow_shorts = config.settings.trading_allow_shorts
        self._original_trading_enabled = config.settings.trading_enabled
        self._original_cooldown = config.settings.trading_cooldown_seconds
        config.settings.trading_enabled = True

    def tearDown(self) -> None:
        config.settings.trading_allow_shorts = self._original_allow_shorts
        config.settings.trading_enabled = self._original_trading_enabled
        config.settings.trading_cooldown_seconds = self._original_cooldown

    def test_sell_reduces_position_bypasses_buying_power(self) -> None:
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("5"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        account = {"equity": "10000", "cash": "100", "buying_power": "10"}
        positions = [{"symbol": "AAPL", "qty": "10", "market_value": "1000"}]
        with self.session_local() as session:
            verdict = self.risk_engine.evaluate(
                session, decision, self.strategy, account, positions, {"AAPL"}
            )
        self.assertTrue(verdict.approved)
        self.assertNotIn("insufficient_buying_power", verdict.reasons)

    def test_short_blocked_by_default(self) -> None:
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        account = {"equity": "10000", "cash": "10000", "buying_power": "10000"}
        positions: list[dict[str, str]] = []
        with self.session_local() as session:
            verdict = self.risk_engine.evaluate(
                session, decision, self.strategy, account, positions, {"AAPL"}
            )
        self.assertFalse(verdict.approved)
        self.assertIn("shorts_not_allowed", verdict.reasons)

    def test_short_allowed_when_enabled(self) -> None:
        config.settings.trading_allow_shorts = True
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        account = {"equity": "10000", "cash": "10000", "buying_power": "10000"}
        positions: list[dict[str, str]] = []
        with self.session_local() as session:
            verdict = self.risk_engine.evaluate(
                session, decision, self.strategy, account, positions, {"AAPL"}
            )
        self.assertTrue(verdict.approved)

    def test_max_position_pct_counts_short_exposure(self) -> None:
        config.settings.trading_allow_shorts = True
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("50"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        account = {"equity": "10000", "cash": "10000", "buying_power": "10000"}
        positions = [{"symbol": "AAPL", "qty": "-40", "market_value": "-4000"}]
        with self.session_local() as session:
            verdict = self.risk_engine.evaluate(
                session, decision, self.strategy, account, positions, {"AAPL"}
            )
        self.assertFalse(verdict.approved)
        self.assertIn("max_position_pct_exceeded", verdict.reasons)

    def test_cooldown_ignores_rejected_decisions(self) -> None:
        config.settings.trading_cooldown_seconds = 60
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        account = {"equity": "10000", "cash": "10000", "buying_power": "10000"}
        positions: list[dict[str, str]] = []
        with self.session_local() as session:
            strategy_id = uuid.uuid4()
            session.add(
                TradeDecision(
                    strategy_id=strategy_id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json={},
                    status="rejected",
                    created_at=datetime.now(timezone.utc) - timedelta(seconds=10),
                )
            )
            session.commit()
            verdict = self.risk_engine.evaluate(
                session, decision, self.strategy, account, positions, {"AAPL"}
            )
        self.assertTrue(verdict.approved)
        self.assertNotIn("cooldown_active", verdict.reasons)

    def test_cooldown_blocks_non_rejected_decisions(self) -> None:
        config.settings.trading_cooldown_seconds = 60
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        account = {"equity": "10000", "cash": "10000", "buying_power": "10000"}
        positions: list[dict[str, str]] = []
        with self.session_local() as session:
            strategy_id = uuid.uuid4()
            session.add(
                TradeDecision(
                    strategy_id=strategy_id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json={},
                    status="planned",
                    created_at=datetime.now(timezone.utc) - timedelta(seconds=10),
                )
            )
            session.commit()
            verdict = self.risk_engine.evaluate(
                session, decision, self.strategy, account, positions, {"AAPL"}
            )
        self.assertFalse(verdict.approved)
        self.assertIn("cooldown_active", verdict.reasons)

    def test_hard_notional_limit_still_enforced_with_allocator_metadata(self) -> None:
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("500"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "allocator": {
                    "status": "approved",
                    "reason_codes": [],
                    "approved_qty": "500",
                },
            },
        )
        account = {"equity": "100000", "cash": "100000", "buying_power": "100000"}
        positions: list[dict[str, str]] = []
        with self.session_local() as session:
            verdict = self.risk_engine.evaluate(
                session, decision, self.strategy, account, positions, {"AAPL"}
            )
        self.assertFalse(verdict.approved)
        self.assertIn("max_notional_exceeded", verdict.reasons)

    def test_allocator_notional_invariant_breach_is_rejected(self) -> None:
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("5"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "allocator": {
                    "status": "approved",
                    "approved_notional": "300",
                    "approved_qty": "3",
                    "reason_codes": ["allocator_clip_symbol_capacity"],
                },
            },
        )
        account = {"equity": "100000", "cash": "100000", "buying_power": "100000"}
        positions: list[dict[str, str]] = []
        with self.session_local() as session:
            verdict = self.risk_engine.evaluate(
                session, decision, self.strategy, account, positions, {"AAPL"}
            )
        self.assertFalse(verdict.approved)
        self.assertIn("allocator_notional_invariant_breached", verdict.reasons)
