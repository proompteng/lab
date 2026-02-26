from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, Execution, ExecutionOrderEvent, ExecutionTCAMetric, Strategy, TradeDecision
from app.config import settings
from app.trading.execution import OrderExecutor
from app.trading.models import StrategyDecision, decision_hash
from app.trading.reconcile import Reconciler
from app.trading.scheduler import _format_order_submit_rejection


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

    def get_order(self, alpaca_order_id: str) -> dict[str, str]:
        return {
            'id': alpaca_order_id,
            'client_order_id': None,
            'symbol': 'AAPL',
            'side': 'buy',
            'type': 'market',
            'time_in_force': 'day',
            'qty': '1',
            'filled_qty': '0',
            'status': 'accepted',
        }


class ConflictingOrderClient(FakeAlpacaClient):
    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        if status != "open":
            return []
        return [
            {
                "id": "order-conflict-1",
                "client_order_id": "existing-open-order",
                "symbol": "AAPL",
                "side": "sell",
                "type": "market",
                "time_in_force": "day",
                "qty": "1",
                "filled_qty": "0",
                "status": "accepted",
            }
        ]


class TestOrderIdempotency(TestCase):
    def setUp(self) -> None:
        engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        self._orig_multi_account_enabled = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = False

    def tearDown(self) -> None:
        settings.trading_multi_account_enabled = self._orig_multi_account_enabled

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

    def test_decision_hash_changes_by_account_when_multi_account_enabled(self) -> None:
        settings.trading_multi_account_enabled = True
        decision = StrategyDecision(
            strategy_id='strategy-1',
            symbol='AAPL',
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe='1Min',
            action='buy',
            qty=Decimal('1.0'),
            order_type='market',
            time_in_force='day',
            params={'signal': 'macd'},
        )
        hash_a = decision_hash(decision, account_label='paper-a')
        hash_b = decision_hash(decision, account_label='paper-b')
        self.assertNotEqual(hash_a, hash_b)

    def test_execution_exists_ignores_unrelated_same_account_execution(self) -> None:
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

            first_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol='AAPL',
                event_ts=datetime(2026, 2, 10, 13, 0, tzinfo=timezone.utc),
                timeframe='1Min',
                action='buy',
                qty=Decimal('1.0'),
                params={'price': Decimal('100')},
            )
            second_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol='AAPL',
                event_ts=datetime(2026, 2, 10, 13, 1, tzinfo=timezone.utc),
                timeframe='1Min',
                action='buy',
                qty=Decimal('1.0'),
                params={'price': Decimal('101')},
            )

            executor = OrderExecutor()
            first_row = executor.ensure_decision(session, first_decision, strategy, 'paper')
            second_row = executor.ensure_decision(session, second_decision, strategy, 'paper')

            client = FakeAlpacaClient()
            first_execution = executor.submit_order(
                session, client, first_decision, first_row, 'paper'
            )
            assert first_execution is not None

            self.assertFalse(executor.execution_exists(session, second_row))

            second_execution = executor.submit_order(
                session, client, second_decision, second_row, 'paper'
            )
            assert second_execution is not None
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(executions), 2)

    def test_execution_exists_matches_by_client_order_id_hash(self) -> None:
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
            assert decision_row.decision_hash is not None

            orphan_execution = Execution(
                trade_decision_id=None,
                alpaca_account_label='paper',
                alpaca_order_id='order-orphan-1',
                client_order_id=decision_row.decision_hash,
                symbol='AAPL',
                side='buy',
                order_type='market',
                time_in_force='day',
                submitted_qty=Decimal('1'),
                filled_qty=Decimal('0'),
                status='accepted',
                raw_order={'id': 'order-orphan-1'},
            )
            session.add(orphan_execution)
            session.commit()

            self.assertTrue(executor.execution_exists(session, decision_row))

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

    def test_submit_order_records_tca_row_with_null_safe_defaults(self) -> None:
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

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1.0"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(session, decision, strategy, "paper")

            execution = executor.submit_order(session, FakeAlpacaClient(), decision, decision_row, "paper")
            assert execution is not None

            tca = session.execute(select(ExecutionTCAMetric).where(ExecutionTCAMetric.execution_id == execution.id)).scalar_one()
            self.assertEqual(tca.arrival_price, Decimal("100"))
            self.assertIsNone(tca.avg_fill_price)
            self.assertIsNone(tca.slippage_bps)
            self.assertIsNone(tca.shortfall_notional)
            self.assertIsNone(tca.expected_shortfall_bps_p50)
            self.assertIsNone(tca.expected_shortfall_bps_p95)
            self.assertIsNone(tca.divergence_bps)

    def test_submit_order_persists_advice_provenance_and_simulator_expectations(self) -> None:
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
                qty=Decimal('2.0'),
                params={
                    'price': Decimal('100'),
                    'execution_advisor': {
                        'applied': True,
                        'adverse_selection_risk': '0.3',
                        'fallback_reason': None,
                    },
                    'execution_advice': {
                        'urgency_tier': 'normal',
                        'expected_shortfall_bps_p50': '12.5',
                        'expected_shortfall_bps_p95': '30.0',
                        'simulator_version': 'hawkes-lob-v1',
                    },
                },
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(session, decision, strategy, 'paper')

            class FilledClient(FakeAlpacaClient):
                def submit_order(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                    order = super().submit_order(*args, **kwargs)
                    order['filled_qty'] = '2'
                    order['filled_avg_price'] = '101'
                    order['status'] = 'filled'
                    return order

            execution = executor.submit_order(session, FilledClient(), decision, decision_row, 'paper')
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            self.assertIn('_execution_advice_provenance', raw_order)

            tca = session.execute(select(ExecutionTCAMetric).where(ExecutionTCAMetric.execution_id == execution.id)).scalar_one()
            self.assertEqual(tca.expected_shortfall_bps_p50, Decimal('12.5'))
            self.assertEqual(tca.expected_shortfall_bps_p95, Decimal('30.0'))
            self.assertEqual(tca.realized_shortfall_bps, Decimal('100'))
            self.assertEqual(tca.divergence_bps, Decimal('87.5'))
            self.assertEqual(tca.simulator_version, 'hawkes-lob-v1')

    def test_submit_order_prefers_persisted_advice_provenance(self) -> None:
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

            persisted_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol='AAPL',
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe='1Min',
                action='buy',
                qty=Decimal('1.0'),
                params={'price': Decimal('100')},
            )
            transient_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol='AAPL',
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe='1Min',
                action='buy',
                qty=Decimal('1.0'),
                params={
                    'price': Decimal('100'),
                    'execution_advisor': {
                        'applied': False,
                        'fallback_reason': 'advisor_missing_inputs',
                        'fallback_reason': 'advisor_missing_inputs',
                    },
                },
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, persisted_decision, strategy, 'paper'
            )
            executor.update_decision_params(
                session,
                decision_row,
                {
                    'execution_advisor': {
                        'applied': True,
                        'fallback_reason': None,
                        'max_participation_rate': '0.03',
                    }
                },
            )

            execution = executor.submit_order(
                session,
                FakeAlpacaClient(),
                transient_decision,
                decision_row,
                'paper',
            )
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            provenance = raw_order.get('_execution_advice_provenance')
            assert isinstance(provenance, dict)
            self.assertEqual(provenance.get('applied'), True)
            self.assertEqual(provenance.get('max_participation_rate'), '0.03')

    def test_submit_order_uses_execution_advisor_expectations_when_raw_advice_absent(self) -> None:
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
                qty=Decimal('2.0'),
                params={
                    'price': Decimal('100'),
                    'execution_advisor': {
                        'applied': False,
                        'fallback_reason': 'advisor_live_apply_disabled',
                        'expected_shortfall_bps_p50': '11.0',
                        'expected_shortfall_bps_p95': '23.0',
                        'simulator_version': 'hawkes-lob-v2',
                    },
                },
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(session, decision, strategy, 'paper')

            class FilledClient(FakeAlpacaClient):
                def submit_order(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                    order = super().submit_order(*args, **kwargs)
                    order['filled_qty'] = '2'
                    order['filled_avg_price'] = '101'
                    order['status'] = 'filled'
                    return order

            execution = executor.submit_order(session, FilledClient(), decision, decision_row, 'paper')
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            self.assertIn('_execution_advice_provenance', raw_order)

            tca = session.execute(
                select(ExecutionTCAMetric).where(ExecutionTCAMetric.execution_id == execution.id)
            ).scalar_one()
            self.assertEqual(tca.expected_shortfall_bps_p50, Decimal('11.0'))
            self.assertEqual(tca.expected_shortfall_bps_p95, Decimal('23.0'))
            self.assertEqual(tca.simulator_version, 'hawkes-lob-v2')
            self.assertEqual(tca.divergence_bps, Decimal('89.0'))

    def test_submit_order_prefers_persisted_execution_policy_context(self) -> None:
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
                params={
                    'price': Decimal('100'),
                    'execution_policy': {
                        'selected_order_type': 'market',
                        'adaptive': {'applied': True, 'reason': 'transient_policy'},
                    },
                },
            )

            executor = OrderExecutor()
            decision_row = executor.ensure_decision(session, decision, strategy, 'paper')
            executor.update_decision_params(
                session,
                decision_row,
                {
                    'execution_policy': {
                        'selected_order_type': 'limit',
                        'adaptive': {'applied': False, 'reason': 'persisted_policy'},
                    }
                },
            )

            execution = executor.submit_order(session, FakeAlpacaClient(), decision, decision_row, 'paper')
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)

            execution_policy = raw_order.get('execution_policy')
            assert isinstance(execution_policy, dict)
            self.assertEqual(execution_policy.get('selected_order_type'), 'limit')
            adaptive = execution_policy.get('adaptive')
            assert isinstance(adaptive, dict)
            self.assertEqual(adaptive.get('reason'), 'persisted_policy')

    def test_submit_order_falls_back_to_transient_execution_policy_context(self) -> None:
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

            persisted_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol='AAPL',
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe='1Min',
                action='buy',
                qty=Decimal('1.0'),
                params={'price': Decimal('100')},
            )
            transient_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol='AAPL',
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe='1Min',
                action='buy',
                qty=Decimal('1.0'),
                params={
                    'price': Decimal('100'),
                    'execution_policy': {
                        'selected_order_type': 'market',
                        'adaptive': {'applied': True, 'reason': 'transient_policy'},
                    },
                },
            )

            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, persisted_decision, strategy, 'paper'
            )
            execution = executor.submit_order(
                session,
                FakeAlpacaClient(),
                transient_decision,
                decision_row,
                'paper',
            )
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)

            execution_policy = raw_order.get('execution_policy')
            assert isinstance(execution_policy, dict)
            self.assertEqual(execution_policy.get('selected_order_type'), 'market')
            adaptive = execution_policy.get('adaptive')
            assert isinstance(adaptive, dict)
            self.assertEqual(adaptive.get('reason'), 'transient_policy')

    def test_submit_order_precheck_blocks_opposite_side_open_order(self) -> None:
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

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1.0"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(session, decision, strategy, "paper")

            client = ConflictingOrderClient()
            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(session, client, decision, decision_row, "paper")

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "broker_precheck")
            self.assertEqual(
                payload.get("code"), "precheck_opposite_side_open_order"
            )
            self.assertEqual(payload.get("existing_order_id"), "order-conflict-1")
            self.assertEqual(len(client.submitted), 0)

    def test_submit_order_precheck_blocks_invalid_equity_fractional_qty(self) -> None:
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

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("0.5"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(session, decision, strategy, "paper")

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(session, FakeAlpacaClient(), decision, decision_row, "paper")

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "local_qty_below_min")

    def test_local_pre_submit_rejection_formats_with_distinct_reason_prefix(self) -> None:
        error = RuntimeError(
            json.dumps(
                {
                    "source": "local_pre_submit",
                    "code": "local_qty_below_min",
                    "reject_reason": "qty below minimum increment 1",
                }
            )
        )
        formatted = _format_order_submit_rejection(error)
        self.assertIn("local_pre_submit_rejected", formatted)
        self.assertIn("code=local_qty_below_min", formatted)

    def test_reconciler_backfills_missing_execution_by_client_order_id(self) -> None:
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

            decision_hash_value = 'decision-hash-1'
            decision_row = TradeDecision(
                strategy_id=str(strategy.id),
                alpaca_account_label='paper',
                symbol='AAPL',
                timeframe='1Min',
                decision_json={'symbol': 'AAPL'},
                rationale=None,
                status='planned',
                decision_hash=decision_hash_value,
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            alpaca_client = FakeAlpacaClient()
            alpaca_client.submitted.append(
                {
                    'id': 'order-1',
                    'client_order_id': decision_hash_value,
                    'symbol': 'AAPL',
                    'side': 'buy',
                    'type': 'market',
                    'time_in_force': 'day',
                    'qty': '1',
                    'filled_qty': '0',
                    'status': 'accepted',
                }
            )

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, alpaca_client)

            self.assertEqual(updates, 1)
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(executions), 1)
            self.assertEqual(executions[0].client_order_id, decision_hash_value)

            refreshed_decision = session.get(TradeDecision, decision_row.id)
            assert refreshed_decision is not None
            self.assertEqual(refreshed_decision.status, 'accepted')

    def test_reconciler_backfill_normalizes_fallback_route_for_new_execution(self) -> None:
        class FallbackAwareAlpacaClient(FakeAlpacaClient):
            last_route = 'alpaca_fallback'

            def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, str] | None:
                return {
                    'id': 'order-2',
                    'client_order_id': client_order_id,
                    'symbol': 'AAPL',
                    'side': 'buy',
                    'type': 'market',
                    'time_in_force': 'day',
                    'qty': '1',
                    'filled_qty': '0',
                    'status': 'accepted',
                    '_execution_route_expected': 'lean',
                    '_execution_route_actual': 'alpaca_fallback',
                }

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

            decision_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label='paper',
                symbol='AAPL',
                timeframe='1Min',
                decision_json={'symbol': 'AAPL'},
                rationale=None,
                status='planned',
                decision_hash='decision-hash-2',
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, FallbackAwareAlpacaClient())

            self.assertEqual(updates, 1)
            execution = session.execute(select(Execution).where(Execution.trade_decision_id == decision_row.id)).scalar_one()
            assert execution is not None
            self.assertEqual(execution.execution_expected_adapter, 'lean')
            self.assertEqual(execution.execution_actual_adapter, 'alpaca')

    def test_reconciler_backfill_sets_expected_from_actual(self) -> None:
        class AdapterOnlyAlpacaClient(FakeAlpacaClient):
            last_route = 'alpaca'

            def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, str] | None:
                return {
                    'id': 'order-3',
                    'client_order_id': client_order_id,
                    'symbol': 'AAPL',
                    'side': 'buy',
                    'type': 'market',
                    'time_in_force': 'day',
                    'qty': '1',
                    'filled_qty': '0',
                    'status': 'accepted',
                    '_execution_adapter': 'lean',
                }

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

            decision_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label='paper',
                symbol='AAPL',
                timeframe='1Min',
                decision_json={'symbol': 'AAPL'},
                rationale=None,
                status='planned',
                decision_hash='decision-hash-3',
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, AdapterOnlyAlpacaClient())

            self.assertEqual(updates, 1)
            execution = session.execute(
                select(Execution).where(Execution.trade_decision_id == decision_row.id)
            ).scalar_one()
            assert execution is not None
            self.assertEqual(execution.execution_expected_adapter, 'lean')
            self.assertEqual(execution.execution_actual_adapter, 'lean')

    def test_reconciler_uses_persisted_order_feed_evidence(self) -> None:
        class FailingOrderFetchClient(FakeAlpacaClient):
            def get_order(self, alpaca_order_id: str) -> dict[str, str]:
                raise AssertionError(f'should_not_fetch_order:{alpaca_order_id}')

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

            decision_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label='paper',
                symbol='AAPL',
                timeframe='1Min',
                decision_json={'symbol': 'AAPL'},
                rationale=None,
                status='submitted',
                decision_hash='decision-hash-4',
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            execution = Execution(
                trade_decision_id=decision_row.id,
                alpaca_order_id='order-4',
                client_order_id='decision-hash-4',
                symbol='AAPL',
                side='buy',
                order_type='market',
                time_in_force='day',
                submitted_qty=Decimal('1'),
                filled_qty=Decimal('0'),
                status='accepted',
                raw_order={'id': 'order-4'},
            )
            session.add(execution)
            session.commit()
            session.refresh(execution)

            event = ExecutionOrderEvent(
                event_fingerprint='feed-event-4',
                source_topic='torghut.trade-updates.v1',
                source_partition=0,
                source_offset=4,
                alpaca_account_label='paper',
                event_ts=datetime.now(timezone.utc),
                feed_seq=100,
                symbol='AAPL',
                alpaca_order_id='order-4',
                client_order_id='decision-hash-4',
                event_type='fill',
                status='filled',
                qty=Decimal('1'),
                filled_qty=Decimal('1'),
                avg_fill_price=Decimal('189.55'),
                raw_event={'event': 'fill'},
                execution_id=execution.id,
                trade_decision_id=decision_row.id,
            )
            session.add(event)
            session.commit()

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, FailingOrderFetchClient())

            self.assertEqual(updates, 1)
            refreshed_execution = session.get(Execution, execution.id)
            assert refreshed_execution is not None
            self.assertEqual(refreshed_execution.status, 'filled')
            self.assertEqual(refreshed_execution.filled_qty, Decimal('1'))

    def test_reconciler_backfill_records_tca_metrics(self) -> None:
        class FilledOrderAlpacaClient(FakeAlpacaClient):
            last_route = 'alpaca'

            def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, str] | None:
                return {
                    'id': 'order-4',
                    'client_order_id': client_order_id,
                    'symbol': 'AAPL',
                    'side': 'buy',
                    'type': 'market',
                    'time_in_force': 'day',
                    'qty': '2',
                    'filled_qty': '2',
                    'filled_avg_price': '101',
                    'status': 'filled',
                }

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

            decision_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label='paper',
                symbol='AAPL',
                timeframe='1Min',
                decision_json={'symbol': 'AAPL', 'params': {'price': '100'}},
                rationale=None,
                status='planned',
                decision_hash='decision-hash-4',
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, FilledOrderAlpacaClient())
            self.assertEqual(updates, 1)

            tca_rows = session.execute(select(ExecutionTCAMetric)).scalars().all()
            self.assertEqual(len(tca_rows), 1)
            tca = tca_rows[0]
            self.assertEqual(tca.symbol, 'AAPL')
            self.assertEqual(tca.arrival_price, Decimal('100'))
            self.assertEqual(tca.avg_fill_price, Decimal('101'))
            self.assertEqual(tca.filled_qty, Decimal('2'))
            self.assertEqual(tca.slippage_bps, Decimal('100'))
            self.assertEqual(tca.shortfall_notional, Decimal('2'))
