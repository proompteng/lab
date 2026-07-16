from __future__ import annotations

from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from app.trading.economic_ledger import reduce_and_compare
from tests.economic_ledger.support import activity


@settings(max_examples=150, deadline=None)
@given(
    fills=st.lists(
        st.tuples(
            st.sampled_from(("buy", "sell")),
            st.integers(min_value=1, max_value=25),
            st.integers(min_value=1, max_value=500),
        ),
        min_size=1,
        max_size=60,
    )
)
def test_random_fill_sequences_have_zero_differential(
    fills: list[tuple[str, int, int]],
) -> None:
    rows = [activity("capital", "JNLC", net_amount="1000000")]
    rows.extend(
        activity(
            f"fill-{index}",
            "FILL",
            event_offset_seconds=index + 1,
            symbol="AAPL",
            side=side,
            quantity=str(quantity),
            price=str(price),
            net_amount=None,
        )
        for index, (side, quantity, price) in enumerate(fills)
    )

    result = reduce_and_compare(rows)

    assert result.admissible
    assert result.comparison.equivalent
    assert all(
        sum(
            (line.amount for line in transaction.lines if line.commodity == commodity),
            start=Decimal("0"),
        )
        == Decimal("0")
        for transaction in result.journal.transactions
        for commodity in {line.commodity for line in transaction.lines}
    )


@settings(max_examples=100, deadline=None)
@given(
    fills=st.lists(
        st.tuples(
            st.sampled_from(("buy", "sell")),
            st.integers(min_value=1, max_value=2_500),
            st.integers(min_value=1_000, max_value=500_000),
        ),
        min_size=1,
        max_size=40,
    )
)
def test_fractional_fill_cash_rounding_has_zero_differential(
    fills: list[tuple[str, int, int]],
) -> None:
    rows = [activity("capital", "JNLC", net_amount="1000000")]
    rows.extend(
        activity(
            f"fractional-fill-{index}",
            "FILL",
            event_offset_seconds=index + 1,
            symbol="BTCUSD",
            side=side,
            quantity=str(Decimal(quantity_hundredths) / Decimal("100")),
            price=str(Decimal(price_thousandths) / Decimal("1000")),
            net_amount=None,
        )
        for index, (side, quantity_hundredths, price_thousandths) in enumerate(fills)
    )

    result = reduce_and_compare(rows)

    assert result.admissible
    assert result.comparison.equivalent
    assert all(
        sum(
            (line.amount for line in transaction.lines if line.commodity == commodity),
            start=Decimal("0"),
        )
        == Decimal("0")
        for transaction in result.journal.transactions
        for commodity in {line.commodity for line in transaction.lines}
    )
