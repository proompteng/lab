from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from app.trading.quantity_rules import (
    fractional_equities_enabled_for_trade,
    min_qty_for_symbol,
    qty_has_valid_increment,
    qty_step_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)
from tests.strategies.trading import position_quantities, positive_quantities, trading_symbols

pytestmark = pytest.mark.property


@given(
    symbol=trading_symbols(include_crypto=True),
    qty=st.decimals(
        min_value=Decimal('0'),
        max_value=Decimal('1000'),
        allow_nan=False,
        allow_infinity=False,
        places=8,
    ),
    fractional_enabled=st.booleans(),
)
def test_quantize_qty_for_symbol_is_idempotent(
    symbol: str,
    qty: Decimal,
    fractional_enabled: bool,
) -> None:
    first = quantize_qty_for_symbol(
        symbol,
        qty,
        fractional_equities_enabled=fractional_enabled,
    )
    second = quantize_qty_for_symbol(
        symbol,
        first,
        fractional_equities_enabled=fractional_enabled,
    )

    assert first == second


@given(
    symbol=trading_symbols(include_crypto=True),
    qty=st.decimals(
        min_value=Decimal('0'),
        max_value=Decimal('1000'),
        allow_nan=False,
        allow_infinity=False,
        places=8,
    ),
    fractional_enabled=st.booleans(),
)
def test_qty_has_valid_increment_matches_quantized_equality(
    symbol: str,
    qty: Decimal,
    fractional_enabled: bool,
) -> None:
    quantized = quantize_qty_for_symbol(
        symbol,
        qty,
        fractional_equities_enabled=fractional_enabled,
    )

    assert qty_has_valid_increment(
        symbol,
        qty,
        fractional_equities_enabled=fractional_enabled,
    ) == (quantized == qty)


@given(symbol=trading_symbols(include_crypto=True), fractional_enabled=st.booleans())
def test_min_qty_matches_qty_step(symbol: str, fractional_enabled: bool) -> None:
    assert min_qty_for_symbol(
        symbol,
        fractional_equities_enabled=fractional_enabled,
    ) == qty_step_for_symbol(
        symbol,
        fractional_equities_enabled=fractional_enabled,
    )


@given(
    position_qty=position_quantities(),
    requested_qty=positive_quantities(),
    allow_shorts=st.booleans(),
)
def test_short_increasing_sell_never_becomes_fractional(
    position_qty: Decimal,
    requested_qty: Decimal,
    allow_shorts: bool,
) -> None:
    assume(position_qty <= 0 or requested_qty > position_qty)

    resolution = resolve_quantity_resolution(
        'AAPL',
        action='sell',
        global_enabled=True,
        allow_shorts=allow_shorts,
        position_qty=position_qty,
        requested_qty=requested_qty,
    )

    assert resolution.short_increasing is True
    assert resolution.fractional_allowed is False
    assert resolution.qty_step == Decimal('1')


@given(position_qty=positive_quantities(), requested_qty=positive_quantities())
def test_reducing_long_sell_keeps_fractional_behavior(
    position_qty: Decimal,
    requested_qty: Decimal,
) -> None:
    assume(requested_qty <= position_qty)

    resolution = resolve_quantity_resolution(
        'AAPL',
        action='sell',
        global_enabled=True,
        allow_shorts=False,
        position_qty=position_qty,
        requested_qty=requested_qty,
    )

    assert resolution.short_increasing is False
    assert resolution.fractional_allowed is True
    assert fractional_equities_enabled_for_trade(
        action='sell',
        global_enabled=True,
        allow_shorts=False,
        position_qty=position_qty,
        requested_qty=requested_qty,
    )
