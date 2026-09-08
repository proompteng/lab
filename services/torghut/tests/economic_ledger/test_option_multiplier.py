from __future__ import annotations

from decimal import Decimal

import pytest

from app.trading.economic_ledger import (
    EconomicLedgerError,
    JOURNAL_REDUCER_VERSION,
    STATE_REDUCER_VERSION,
    reduce_and_compare,
)
from tests.economic_ledger.support import activity, cash, position


def test_option_fill_cash_and_cost_use_the_explicit_contract_size() -> None:
    buy = activity(
        "option-buy",
        "FILL",
        symbol="AMZN260529P00270000",
        side="buy",
        quantity="2",
        price="1.05",
        contract_size="10",
        net_amount=None,
    )
    result = reduce_and_compare(
        [
            buy,
            activity(
                "option-sell",
                "FILL",
                event_offset_seconds=1,
                symbol="AMZN260529P00270000",
                side="sell",
                quantity="2",
                price="1.20",
                contract_size="10",
                net_amount=None,
            ),
        ]
    )

    assert buy.manifest_payload()["notional_multiplier"] == "10"
    assert JOURNAL_REDUCER_VERSION == "torghut.broker-economic-journal.v5"
    assert STATE_REDUCER_VERSION == "torghut.broker-economic-state.v5"
    assert result.admissible
    assert result.comparison.equivalent
    assert cash(result.journal.projection) == Decimal("3")
    assert result.journal.projection.realized_pnl == Decimal("3")
    assert position(result.journal.projection, "AMZN260529P00270000") is None
    assert [
        line.amount
        for transaction in result.journal.transactions
        for line in transaction.lines
        if line.account == "asset:cash"
    ] == [Decimal("-21"), Decimal("24")]


def test_option_activity_requires_catalog_contract_size() -> None:
    with pytest.raises(
        EconomicLedgerError,
        match="economic_option_contract_size_missing",
    ):
        activity(
            "option-without-catalog",
            "FILL",
            symbol="AMZN260529P00270000",
            side="buy",
            quantity="1",
            price="1.05",
            net_amount=None,
        )


def test_non_option_activity_rejects_contract_size() -> None:
    with pytest.raises(
        EconomicLedgerError,
        match="economic_non_option_contract_size_present",
    ):
        activity(
            "stock-with-contract-size",
            "FILL",
            symbol="AAPL",
            side="buy",
            quantity="1",
            price="10",
            contract_size="100",
            net_amount=None,
        )


def test_non_option_fill_keeps_unit_notional_multiplier() -> None:
    stock_fill = activity(
        "stock-buy",
        "FILL",
        symbol="AAPL",
        side="buy",
        quantity="2",
        price="10",
        net_amount=None,
    )

    result = reduce_and_compare([stock_fill])

    assert stock_fill.manifest_payload()["notional_multiplier"] == "1"
    assert cash(result.journal.projection) == Decimal("-20")
