from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from unittest import TestCase

from app.models import Base, Execution, ExecutionOrderEvent, PositionSnapshot, Strategy, TradeDecision


class TestModels(TestCase):
    def test_model_metadata_create_all(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)

        with Session(engine) as session:
            strategy = Strategy(
                name="demo",
                description="demo strat",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL", "MSFT"],
                max_position_pct_equity=Decimal("0.10"),
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                rationale="test",
                decision_hash="decision-1",
            )
            session.add(decision)
            session.commit()

            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="paper",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="accepted",
                raw_order={"id": "order-1"},
            )
            session.add(execution)
            session.commit()

            order_event = ExecutionOrderEvent(
                event_fingerprint="fingerprint-1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=decision.id,
            )
            session.add(order_event)
            session.commit()

            snapshot = PositionSnapshot(
                alpaca_account_label="paper",
                as_of=datetime.now(timezone.utc),
                equity=Decimal("10000"),
                cash=Decimal("10000"),
                buying_power=Decimal("10000"),
                positions=[],
            )
            session.add(snapshot)
            session.commit()

            found_strategy = session.execute(select(Strategy)).scalar_one()
            found_decision = session.execute(select(TradeDecision)).scalar_one()
            found_execution = session.execute(select(Execution)).scalar_one()
            found_order_event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            found_snapshot = session.execute(select(PositionSnapshot)).scalar_one()

            self.assertTrue(found_strategy.enabled)
            self.assertEqual(found_decision.status, "planned")
            self.assertEqual(found_execution.filled_qty, Decimal("0"))
            self.assertEqual(found_order_event.event_type, "fill")
            self.assertEqual(found_snapshot.equity, Decimal("10000"))

    def test_account_scoped_uniques_allow_same_ids_across_accounts(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)

        with Session(engine) as session:
            strategy = Strategy(
                name="demo",
                description="demo strat",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.flush()

            decision_a = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper-a",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                decision_hash="shared-hash",
            )
            decision_b = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper-b",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                decision_hash="shared-hash",
            )
            session.add_all([decision_a, decision_b])
            session.flush()

            execution_a = Execution(
                trade_decision_id=decision_a.id,
                alpaca_account_label="paper-a",
                alpaca_order_id="shared-order",
                client_order_id="shared-client",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="accepted",
                raw_order={"id": "shared-order"},
            )
            execution_b = Execution(
                trade_decision_id=decision_b.id,
                alpaca_account_label="paper-b",
                alpaca_order_id="shared-order",
                client_order_id="shared-client",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="accepted",
                raw_order={"id": "shared-order"},
            )
            session.add_all([execution_a, execution_b])
            session.commit()

            execution_duplicate = Execution(
                trade_decision_id=decision_a.id,
                alpaca_account_label="paper-a",
                alpaca_order_id="shared-order",
                client_order_id="shared-client",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="accepted",
                raw_order={"id": "shared-order"},
            )
            session.add(execution_duplicate)
            with self.assertRaises(IntegrityError):
                session.commit()
            session.rollback()
