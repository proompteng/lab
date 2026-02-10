from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, Execution, Strategy, TradeDecision
from app.trading.execution import OrderExecutor
from app.trading.models import StrategyDecision, decision_hash


class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submitted: list[dict[str, str]] = []

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
            'id': f'order-{len(self.submitted) + 1}',
            'client_order_id': extra_params.get('client_order_id') if extra_params else None,
            'symbol': symbol,
            'side': side,
            'type': order_type,
            'time_in_force': time_in_force,
            'qty': str(qty),
            'filled_qty': '0',
            'status': 'accepted',
        }
        self.submitted.append(order)
        return order

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, str] | None:
        return next((order for order in self.submitted if order.get('client_order_id') == client_order_id), None)


class TestOrderIdempotency(TestCase):
    def setUp(self) -> None:
        engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def test_decision_hash_stable_for_same_intent(self) -> None:
        event_ts = datetime(2026, 2, 10, tzinfo=timezone.utc)
        decision_a = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=event_ts,
            timeframe='1Min',
            action='buy',
            qty=Decimal('1.0'),
            order_type='market',
            time_in_force='day',
            params={'signal': 'macd', 'threshold': Decimal('1.5')},
        )
        decision_b = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=event_ts,
            timeframe='1Min',
            action='buy',
            qty=Decimal('1.0'),
            order_type='market',
            time_in_force='day',
            params={'threshold': Decimal('1.5'), 'signal': 'macd'},
        )

        self.assertEqual(decision_hash(decision_a), decision_hash(decision_b))

    def test_retry_after_db_failure_does_not_duplicate_submit(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name='demo',
                description='demo',
                enabled=True,
                base_timeframe='1Min',
                universe_type='static',
                universe_symbols=['AAPL'],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol='AAPL',
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe='1Min',
                action='buy',
                qty=Decimal('1.0'),
                params={'price': Decimal('100')},
            )

            executor = OrderExecutor()
            decision_row = executor.ensure_decision(session, decision, strategy, 'paper')

            alpaca_client = FakeAlpacaClient()

            with patch('app.trading.execution.sync_order_to_db') as sync_mock:
                sync_mock.side_effect = RuntimeError('db write failed')
                with self.assertRaises(RuntimeError):
                    executor.submit_order(session, alpaca_client, decision, decision_row, 'paper')
                session.rollback()

            decision_row = session.get(TradeDecision, decision_row.id)
            assert decision_row is not None

            executor.submit_order(session, alpaca_client, decision, decision_row, 'paper')

            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(executions), 1)
            self.assertEqual(len(alpaca_client.submitted), 1)
