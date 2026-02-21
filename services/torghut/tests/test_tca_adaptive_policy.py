from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, Execution, ExecutionTCAMetric, Strategy, TradeDecision
from app.trading.tca import derive_adaptive_execution_policy


class TestAdaptiveExecutionPolicyDerivation(TestCase):
    def setUp(self) -> None:
        engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def test_derivation_builds_defensive_override_for_high_recent_slippage(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol='AAPL',
                regime='trend',
                slippages=[
                    Decimal('10'),
                    Decimal('10'),
                    Decimal('10'),
                    Decimal('25'),
                    Decimal('25'),
                    Decimal('25'),
                ],
                shortfalls=[
                    Decimal('2'),
                    Decimal('2'),
                    Decimal('2'),
                    Decimal('20'),
                    Decimal('20'),
                    Decimal('20'),
                ],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol='AAPL',
                regime_label='trend',
            )

        self.assertEqual(decision.aggressiveness, 'defensive')
        self.assertEqual(decision.prefer_limit, True)
        self.assertFalse(decision.fallback_active)
        self.assertEqual(decision.sample_size, 6)
        self.assertEqual(decision.regime_label, 'trend')

    def test_derivation_triggers_fallback_when_adaptive_degrades(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol='AAPL',
                regime='all',
                slippages=[
                    Decimal('10'),
                    Decimal('10'),
                    Decimal('10'),
                    Decimal('18'),
                    Decimal('18'),
                    Decimal('18'),
                ],
                shortfalls=[
                    Decimal('3'),
                    Decimal('3'),
                    Decimal('3'),
                    Decimal('9'),
                    Decimal('9'),
                    Decimal('9'),
                ],
                adaptive_applied=True,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol='AAPL',
                regime_label=None,
            )

        self.assertTrue(decision.fallback_active)
        self.assertEqual(decision.fallback_reason, 'adaptive_policy_degraded')
        self.assertIsNone(decision.prefer_limit)
        self.assertGreater(decision.degradation_bps or Decimal('0'), Decimal('4'))

    def _insert_strategy(self, session: Session) -> Strategy:
        strategy = Strategy(
            name='adaptive-policy-test',
            description='test',
            enabled=True,
            base_timeframe='1Min',
            universe_type='static',
            universe_symbols=['AAPL'],
        )
        session.add(strategy)
        session.commit()
        session.refresh(strategy)
        return strategy

    def _insert_observations(
        self,
        session: Session,
        strategy: Strategy,
        *,
        symbol: str,
        regime: str,
        slippages: list[Decimal],
        shortfalls: list[Decimal],
        adaptive_applied: bool,
    ) -> None:
        base_ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for idx, slippage in enumerate(slippages):
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label='paper',
                symbol=symbol,
                timeframe='1Min',
                decision_json={
                    'strategy_id': str(strategy.id),
                    'symbol': symbol,
                    'action': 'buy',
                    'qty': '1',
                    'params': {
                        'regime_label': regime,
                        'execution_policy': {
                            'adaptive': {
                                'applied': adaptive_applied,
                            }
                        },
                    },
                },
                rationale='test',
                status='submitted',
                decision_hash=f'hash-{regime}-{idx}',
            )
            session.add(decision)
            session.flush()

            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id=f'order-{regime}-{idx}',
                client_order_id=f'client-{regime}-{idx}',
                symbol=symbol,
                side='buy',
                order_type='market',
                time_in_force='day',
                submitted_qty=Decimal('1'),
                filled_qty=Decimal('1'),
                avg_fill_price=Decimal('100'),
                status='filled',
                execution_expected_adapter='alpaca',
                execution_actual_adapter='alpaca',
            )
            session.add(execution)
            session.flush()

            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=decision.id,
                strategy_id=strategy.id,
                alpaca_account_label='paper',
                symbol=symbol,
                side='buy',
                arrival_price=Decimal('100'),
                avg_fill_price=Decimal('100'),
                filled_qty=Decimal('1'),
                signed_qty=Decimal('1'),
                slippage_bps=slippage,
                shortfall_notional=shortfalls[idx],
                churn_qty=Decimal('0'),
                churn_ratio=Decimal('0'),
                computed_at=base_ts + timedelta(minutes=idx),
            )
            session.add(metric)

        session.commit()

