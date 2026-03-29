from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.trading.models import StrategyDecision
from app.trading.portfolio import AllocationConfig, PortfolioAllocator

pytestmark = pytest.mark.property


def _allocator(symbol_cap_pct: Decimal) -> PortfolioAllocator:
    return PortfolioAllocator(
        AllocationConfig(
            enabled=True,
            default_regime='neutral',
            default_budget_multiplier=Decimal('1.0'),
            default_capacity_multiplier=Decimal('1.0'),
            min_multiplier=Decimal('0'),
            max_multiplier=Decimal('2'),
            max_symbol_pct_equity=symbol_cap_pct,
            max_symbol_notional=None,
            max_gross_exposure=None,
            strategy_notional_caps={},
            symbol_notional_caps={},
            correlation_group_caps={},
            symbol_correlation_groups={},
            regime_budget_multipliers={},
            regime_capacity_multipliers={},
        )
    )


def _decision(price: Decimal, qty: Decimal) -> StrategyDecision:
    return StrategyDecision(
        strategy_id='s1',
        symbol='AAPL',
        event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
        timeframe='1Min',
        action='buy',
        qty=qty,
        order_type='market',
        time_in_force='day',
        params={
            'price': price,
            'fragility_state': 'normal',
            'spread_acceleration': Decimal('0'),
            'liquidity_compression': Decimal('0'),
            'crowding_proxy': Decimal('0'),
            'correlation_concentration': Decimal('0'),
        },
    )


@given(
    price=st.decimals(
        min_value=Decimal('10'),
        max_value=Decimal('1000'),
        allow_nan=False,
        allow_infinity=False,
        places=2,
    ),
    qty=st.integers(min_value=1, max_value=500).map(Decimal),
    loose_cap=st.decimals(
        min_value=Decimal('0.05'),
        max_value=Decimal('0.50'),
        allow_nan=False,
        allow_infinity=False,
        places=2,
    ),
    tight_cap=st.decimals(
        min_value=Decimal('0.01'),
        max_value=Decimal('0.25'),
        allow_nan=False,
        allow_infinity=False,
        places=2,
    ),
)
def test_tighter_symbol_cap_never_increases_allocated_qty(
    price: Decimal,
    qty: Decimal,
    loose_cap: Decimal,
    tight_cap: Decimal,
) -> None:
    assume_tight = tight_cap <= loose_cap
    if not assume_tight:
        tight_cap, loose_cap = loose_cap, tight_cap

    decision = _decision(price, qty)
    account = {'equity': '10000', 'buying_power': '10000', 'cash': '10000'}
    loose_result = _allocator(loose_cap).allocate(
        [decision],
        account=account,
        positions=[],
        regime_label='neutral',
    )[0]
    tight_result = _allocator(tight_cap).allocate(
        [decision],
        account=account,
        positions=[],
        regime_label='neutral',
    )[0]

    assert tight_result.decision.qty <= loose_result.decision.qty
