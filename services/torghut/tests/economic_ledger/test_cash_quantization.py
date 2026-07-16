from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest

from app.trading.economic_ledger import (
    EconomicLedgerError,
    LedgerScope,
    reduce_and_compare,
    reduce_balanced_journal,
    reduce_independent_state,
)
from tests.economic_ledger.support import SCOPE, activity, cash, position


def test_fill_cash_uses_broker_cents_without_rounding_position_cost() -> None:
    result = reduce_and_compare(
        [
            activity(
                "crypto-buy",
                "FILL",
                symbol="BTCUSD",
                side="buy",
                quantity="1",
                price="29.21760773",
                net_amount=None,
            ),
            activity(
                "crypto-sell",
                "FILL",
                event_offset_seconds=1,
                symbol="BTCUSD",
                side="sell",
                quantity="1",
                price="29.12097393",
                net_amount=None,
            ),
        ]
    )

    assert result.admissible
    assert result.comparison.equivalent
    assert cash(result.journal.projection) == Decimal("-0.10")
    assert result.journal.projection.realized_pnl == Decimal("-0.0966338")
    assert result.journal.projection.cash_rounding == Decimal("0.0033662")
    assert position(result.journal.projection, "BTCUSD") is None
    assert [
        line.amount
        for transaction in result.journal.transactions
        for line in transaction.lines
        if line.account == "asset:cash"
    ] == [Decimal("-29.22"), Decimal("29.12")]
    assert [
        line.amount
        for transaction in result.journal.transactions
        for line in transaction.lines
        if line.account == "expense:cash_rounding"
    ] == [Decimal("0.00239227"), Decimal("0.00097393")]


@pytest.mark.parametrize(
    ("side", "expected_cash", "expected_rounding"),
    [
        ("buy", Decimal("-1.01"), Decimal("0.005")),
        ("sell", Decimal("1.01"), Decimal("-0.005")),
    ],
)
def test_fill_cash_half_cent_rounds_away_from_zero(
    side: str,
    expected_cash: Decimal,
    expected_rounding: Decimal,
) -> None:
    result = reduce_and_compare(
        [
            activity(
                f"half-cent-{side}",
                "FILL",
                symbol="AAPL",
                side=side,
                quantity="1",
                price="1.005",
                net_amount=None,
            )
        ]
    )

    assert result.admissible
    assert result.comparison.equivalent
    assert cash(result.journal.projection) == expected_cash
    assert result.journal.projection.cash_rounding == expected_rounding
    aapl = position(result.journal.projection, "AAPL")
    assert aapl is not None
    assert abs(aapl.signed_cost) == Decimal("1.005")


def test_fill_cash_rejects_unproved_quote_currency_precision() -> None:
    unsupported_scope = LedgerScope(
        provider=SCOPE.provider,
        environment=SCOPE.environment,
        account_label=SCOPE.account_label,
        endpoint_fingerprint=SCOPE.endpoint_fingerprint,
        quote_currency="BTC",
    )
    fill = replace(
        activity(
            "unsupported-cash-precision",
            "FILL",
            symbol="ETH/BTC",
            side="buy",
            quantity="1",
            price="0.1",
            currency="BTC",
            net_amount=None,
        ),
        scope=unsupported_scope,
    )

    for reducer in (reduce_balanced_journal, reduce_independent_state):
        with pytest.raises(
            EconomicLedgerError,
            match="economic_broker_cash_currency_unsupported",
        ):
            reducer([fill])
