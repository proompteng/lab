from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest
from hypothesis import settings
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule, run_state_machine_as_test

from app.trading.costs import TransactionCostModel
from app.trading.models import StrategyDecision
from scripts.local_intraday_tsmom_replay import (
    _apply_filled_decision,
    _decision_position_owner,
    _positions_payload,
    _reconcile_pending_order_before_immediate_fill,
)
from tests.strategies.replay import pending_order, position_state, replay_signals
from tests.strategies.trading import positive_prices, positive_quantities, strategy_ids

pytestmark = [pytest.mark.property, pytest.mark.stateful]


class ReplayStateMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.positions = {}
        self.pending_orders = {}
        self.last_prices = {'META': Decimal('100')}
        self.day_bucket = {
            'decision_count': 0,
            'filled_count': 0,
            'gross_pnl': Decimal('0'),
            'net_pnl': Decimal('0'),
            'cost_total': Decimal('0'),
            'wins': 0,
            'losses': 0,
            'closed_trades': [],
        }
        self.cash = Decimal('100000')
        self.closed_trades = []

    @staticmethod
    def _runtime_params() -> dict[str, object]:
        return {'strategy_runtime': {'position_isolation_mode': 'per_strategy'}}

    @rule(
        strategy_id=strategy_ids(),
        qty=positive_quantities(),
        entry_price=positive_prices(),
    )
    def seed_long_position(self, strategy_id: str, qty: Decimal, entry_price: Decimal) -> None:
        self.positions[('META', strategy_id)] = position_state(
            strategy_id=strategy_id,
            qty=qty,
            entry_price=entry_price,
            event_ts=datetime(2026, 3, 27, 17, 30, tzinfo=timezone.utc),
        )
        self.last_prices['META'] = entry_price

    @rule(
        strategy_id=strategy_ids(),
        qty=positive_quantities(),
        limit_price=positive_prices(),
        signal=replay_signals(symbol='META'),
    )
    def queue_pending_buy(
        self,
        strategy_id: str,
        qty: Decimal,
        limit_price: Decimal,
        signal,
    ) -> None:
        decision = StrategyDecision(
            strategy_id=strategy_id,
            symbol='META',
            event_ts=signal.event_ts,
            timeframe='1Sec',
            action='buy',
            qty=qty,
            order_type='limit',
            time_in_force='day',
            limit_price=limit_price,
            rationale='hypothesis_pending_buy',
            params=self._runtime_params(),
        )
        self.pending_orders[('META', strategy_id)] = pending_order(
            decision=decision,
            signal=signal,
        )

    @rule(
        strategy_id=strategy_ids(),
        qty=positive_quantities(),
        limit_price=positive_prices(),
        signal=replay_signals(symbol='META'),
    )
    def queue_pending_sell(
        self,
        strategy_id: str,
        qty: Decimal,
        limit_price: Decimal,
        signal,
    ) -> None:
        existing = self.positions.get(('META', strategy_id))
        if existing is None:
            self.positions[('META', strategy_id)] = position_state(
                strategy_id=strategy_id,
                qty=qty,
                entry_price=limit_price,
                event_ts=datetime(2026, 3, 27, 17, 30, tzinfo=timezone.utc),
            )
        decision = StrategyDecision(
            strategy_id=strategy_id,
            symbol='META',
            event_ts=signal.event_ts,
            timeframe='1Sec',
            action='sell',
            qty=qty,
            order_type='limit',
            time_in_force='day',
            limit_price=limit_price,
            rationale='hypothesis_pending_sell',
            params=self._runtime_params(),
        )
        self.pending_orders[('META', strategy_id)] = pending_order(
            decision=decision,
            signal=signal,
        )

    @rule(
        strategy_id=strategy_ids(),
        qty=positive_quantities(),
        fill_price=positive_prices(),
        signal=replay_signals(symbol='META'),
    )
    def immediate_fill_buy_clears_same_owner_pending_order(
        self,
        strategy_id: str,
        qty: Decimal,
        fill_price: Decimal,
        signal,
    ) -> None:
        decision = StrategyDecision(
            strategy_id=strategy_id,
            symbol='META',
            event_ts=signal.event_ts,
            timeframe='1Sec',
            action='buy',
            qty=qty,
            order_type='market',
            time_in_force='day',
            rationale='hypothesis_immediate_fill',
            params=self._runtime_params(),
        )
        self.pending_orders.setdefault(
            ('META', strategy_id),
            pending_order(
                decision=StrategyDecision(
                    strategy_id=strategy_id,
                    symbol='META',
                    event_ts=signal.event_ts,
                    timeframe='1Sec',
                    action='buy',
                    qty=qty,
                    order_type='limit',
                    time_in_force='day',
                    limit_price=fill_price,
                    rationale='resting',
                    params=self._runtime_params(),
                ),
                signal=signal,
            ),
        )

        _reconcile_pending_order_before_immediate_fill(
            decision=decision,
            pending_orders=self.pending_orders,
            created_at=signal.event_ts,
        )
        self.cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=fill_price,
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=self.positions,
            day_bucket=self.day_bucket,
            cost_model=TransactionCostModel(),
            cash=self.cash,
            all_closed_trades=self.closed_trades,
        )

        assert ('META', _decision_position_owner(decision)) not in self.pending_orders

    @invariant()
    def projected_positions_never_go_negative(self) -> None:
        payload = _positions_payload(
            self.positions,
            self.last_prices,
            self.pending_orders,
        )
        for position in self.positions.values():
            assert position.qty > 0
        for row in payload:
            assert Decimal(row['qty']) > 0
            assert row['side'] == 'long'


def test_replay_state_machine() -> None:
    run_state_machine_as_test(
        ReplayStateMachine,
        settings=settings(max_examples=20, stateful_step_count=20, deadline=None),
    )
