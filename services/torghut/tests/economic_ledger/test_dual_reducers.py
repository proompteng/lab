from __future__ import annotations

import hashlib
from dataclasses import replace
from decimal import Decimal, localcontext

import pytest

from app.trading.economic_ledger import (
    EconomicLedgerCorrectionError,
    EconomicLedgerError,
    EconomicLedgerSourceContradiction,
    LedgerLine,
    LedgerTransaction,
    PositionBalance,
    prepare_activities,
    reduce_and_compare,
    reduce_balanced_journal,
    reduce_independent_state,
)
from app.trading.economic_ledger.types import decimal_text
from tests.economic_ledger.support import activity, cash, position


def test_partial_fills_and_full_round_trip_balance_exactly() -> None:
    result = reduce_and_compare(
        [
            activity("cash", "JNLC", net_amount="1000"),
            activity(
                "buy",
                "FILL",
                event_offset_seconds=1,
                symbol="AAPL",
                side="buy",
                quantity="10",
                price="10",
                net_amount=None,
            ),
            activity(
                "partial-sell",
                "FILL",
                event_offset_seconds=2,
                symbol="AAPL",
                side="sell",
                quantity="4",
                price="12",
                net_amount=None,
            ),
            activity(
                "final-sell",
                "FILL",
                event_offset_seconds=3,
                symbol="AAPL",
                side="sell",
                quantity="6",
                price="8",
                net_amount=None,
            ),
        ]
    )

    assert result.admissible
    assert result.comparison.equivalent
    assert cash(result.journal.projection) == Decimal("996")
    assert position(result.journal.projection, "AAPL") is None
    assert result.journal.projection.realized_pnl == Decimal("-4")
    assert result.journal.projection.external_flows == Decimal("1000")


def test_historical_sell_short_fill_is_a_sell_direction_without_relabeling() -> None:
    short_fill = activity(
        "short-open",
        "FILL",
        event_offset_seconds=1,
        symbol="AAPL",
        side="sell_short",
        quantity="2",
        price="10",
        net_amount=None,
    )
    result = reduce_and_compare(
        [
            short_fill,
            activity(
                "short-close",
                "FILL",
                event_offset_seconds=2,
                symbol="AAPL",
                side="buy",
                quantity="2",
                price="8",
                net_amount=None,
            ),
        ]
    )

    assert short_fill.manifest_payload()["side"] == "sell_short"
    assert result.admissible
    assert result.comparison.equivalent
    assert cash(result.independent) == Decimal("4")
    assert position(result.independent, "AAPL") is None
    assert result.independent.realized_pnl == Decimal("4")


def test_fill_notional_below_ledger_quantum_is_rejected_by_both_reducers() -> None:
    tiny_fill = activity(
        "tiny-fill",
        "FILL",
        symbol="BTCUSD",
        side="buy",
        quantity="0.000000000000000001",
        price="0.000000000000000001",
        net_amount=None,
    )

    for reducer in (reduce_balanced_journal, reduce_independent_state):
        with pytest.raises(
            EconomicLedgerError,
            match="economic_fill_notional_below_ledger_quantum",
        ):
            reducer([tiny_fill])


def test_nonzero_position_cannot_have_zero_carrying_cost() -> None:
    with pytest.raises(
        EconomicLedgerError,
        match="economic_position_nonzero_quantity_zero_cost",
    ):
        PositionBalance(
            symbol="AAPL",
            quantity=Decimal("0.000000000000000001"),
            signed_cost=Decimal("0"),
        )


def test_side_flip_cannot_open_nonzero_units_with_zero_cost() -> None:
    activities = [
        activity(
            "short-open",
            "FILL",
            symbol="AAPL",
            side="sell",
            quantity="1",
            price="1",
            net_amount=None,
        ),
        activity(
            "sub-quantum-flip",
            "FILL",
            event_offset_seconds=1,
            symbol="AAPL",
            side="buy",
            quantity="1.000000000000000001",
            price="0.000000000000000001",
            net_amount=None,
        ),
    ]

    for reducer in (reduce_balanced_journal, reduce_independent_state):
        with pytest.raises(
            EconomicLedgerError,
            match="economic_fill_position_cost_below_ledger_quantum",
        ):
            reducer(activities)


def test_repeating_weighted_average_rounds_once_and_stays_exactly_balanced() -> None:
    result = reduce_and_compare(
        [
            activity(
                "short-one",
                "FILL",
                event_offset_seconds=1,
                symbol="AAPL",
                side="sell",
                quantity="1",
                price="1",
                net_amount=None,
            ),
            activity(
                "short-two",
                "FILL",
                event_offset_seconds=2,
                symbol="AAPL",
                side="sell",
                quantity="1",
                price="1",
                net_amount=None,
            ),
            activity(
                "short-three",
                "FILL",
                event_offset_seconds=3,
                symbol="AAPL",
                side="sell",
                quantity="1",
                price="2",
                net_amount=None,
            ),
            activity(
                "partial-cover",
                "FILL",
                event_offset_seconds=4,
                symbol="AAPL",
                side="buy",
                quantity="1",
                price="1",
                net_amount=None,
            ),
            activity(
                "flip-long",
                "FILL",
                event_offset_seconds=5,
                symbol="AAPL",
                side="buy",
                quantity="5",
                price="4",
                net_amount=None,
            ),
        ]
    )

    assert result.comparison.equivalent
    aapl = position(result.journal.projection, "AAPL")
    assert aapl is not None
    assert aapl.quantity == Decimal("3")
    assert aapl.signed_cost == Decimal("12")
    assert all(
        sum(
            (line.amount for line in transaction.lines if line.commodity == commodity),
            start=Decimal("0"),
        )
        == Decimal("0")
        for transaction in result.journal.transactions
        for commodity in {line.commodity for line in transaction.lines}
    )


def test_source_decimal_precision_beyond_database_contract_fails_closed() -> None:
    with pytest.raises(EconomicLedgerError, match="quantity_scale_exceeds_18"):
        activity(
            "over-precise",
            "FILL",
            symbol="AAPL",
            side="buy",
            quantity="0.0000000000000000001",
            price="1",
            net_amount=None,
        )

    with pytest.raises(EconomicLedgerError, match="price_out_of_range"):
        activity(
            "over-range",
            "FILL",
            symbol="AAPL",
            side="buy",
            quantity="1",
            price="100000000000000000000",
            net_amount=None,
        )


def test_decimal_serialization_preserves_all_38_digits_in_any_active_context() -> None:
    maximum = Decimal("99999999999999999999.999999999999999999")
    predecessor = Decimal("99999999999999999999.999999999999999998")

    with localcontext() as context:
        context.prec = 6
        maximum_text = decimal_text(maximum)
        predecessor_text = decimal_text(predecessor)

    assert maximum_text == "99999999999999999999.999999999999999999"
    assert predecessor_text == "99999999999999999999.999999999999999998"
    assert maximum_text != predecessor_text


def test_short_cover_and_side_flip_use_signed_cost() -> None:
    result = reduce_and_compare(
        [
            activity("cash", "CSD", net_amount="1000"),
            activity(
                "short",
                "FILL",
                event_offset_seconds=1,
                symbol="AMD",
                side="sell",
                quantity="10",
                price="20",
                net_amount=None,
            ),
            activity(
                "partial-cover",
                "FILL",
                event_offset_seconds=2,
                symbol="AMD",
                side="buy",
                quantity="4",
                price="15",
                net_amount=None,
            ),
            activity(
                "flip-long",
                "FILL",
                event_offset_seconds=3,
                symbol="AMD",
                side="buy",
                quantity="8",
                price="18",
                net_amount=None,
            ),
        ]
    )

    assert result.comparison.equivalent
    assert cash(result.independent) == Decimal("996")
    amd = position(result.independent, "AMD")
    assert amd is not None
    assert amd.quantity == Decimal("2")
    assert amd.signed_cost == Decimal("36")
    assert result.independent.realized_pnl == Decimal("32")


def test_cash_fees_dividends_interest_and_withdrawal_remain_separate() -> None:
    result = reduce_and_compare(
        [
            activity("deposit", "JNLC", net_amount="1000"),
            activity("fee", "FEE", subtype="TAF", net_amount="-1.5"),
            activity("dividend", "DIV", net_amount="5"),
            activity("interest", "INT", net_amount="2"),
            activity("withdrawal", "CSW", net_amount="-100"),
        ]
    )

    assert result.admissible
    assert cash(result.journal.projection) == Decimal("905.5")
    assert result.journal.projection.fees == Decimal("1.5")
    assert result.journal.projection.dividends == Decimal("5")
    assert result.journal.projection.interest == Decimal("2")
    assert result.journal.projection.external_flows == Decimal("900")


def test_regulatory_dividend_and_withholding_fees_use_distinct_accounts() -> None:
    result = reduce_and_compare(
        [
            activity("deposit", "JNLC", net_amount="10"),
            activity("occ-fee", "FEE", subtype="OCC", net_amount="-0.03"),
            activity("dividend-fee", "DIVFEE", net_amount="-0.50"),
            activity("withholding", "DIVFT", net_amount="-0.25"),
        ]
    )

    expense_accounts_by_activity = {
        transaction.source_activity_id: line.account
        for transaction in result.journal.transactions
        for line in transaction.lines
        if line.account.startswith("expense:")
    }
    assert expense_accounts_by_activity == {
        "dividend-fee": "expense:broker_fee",
        "occ-fee": "expense:regulatory_fee",
        "withholding": "expense:withholding",
    }
    assert result.comparison.equivalent
    assert result.journal.projection.fees == Decimal("0.78")


@pytest.mark.parametrize(
    "activity_type",
    ("DIVFT", "DIVNRA", "DIVTW", "INTNRA", "INTTW"),
)
def test_tax_withholding_is_expense_not_negative_income(
    activity_type: str,
) -> None:
    result = reduce_and_compare(
        [activity("withholding", activity_type, net_amount="-1.25")]
    )

    assert result.comparison.equivalent
    assert cash(result.journal.projection) == Decimal("-1.25")
    assert result.journal.projection.fees == Decimal("1.25")
    assert result.journal.projection.dividends == Decimal("0")
    assert result.journal.projection.interest == Decimal("0")
    assert result.independent.fees == Decimal("1.25")
    assert result.independent.dividends == Decimal("0")
    assert result.independent.interest == Decimal("0")
    assert {
        line.account
        for transaction in result.journal.transactions
        for line in transaction.lines
        if line.account.startswith("expense:")
    } == {"expense:withholding"}


def test_crypto_asset_fee_reduces_units_and_records_after_cost_economics() -> None:
    result = reduce_and_compare(
        [
            activity("deposit", "JNLC", net_amount="1000"),
            activity(
                "btc-buy",
                "FILL",
                event_offset_seconds=1,
                symbol="BTC/USD",
                side="buy",
                quantity="1",
                price="100",
                net_amount=None,
            ),
            activity(
                "btc-fee",
                "CFEE",
                event_offset_seconds=2,
                symbol="BTCUSD",
                quantity="-0.01",
                price="110",
                net_amount="0",
            ),
            activity(
                "cash-crypto-fee",
                "CFEE",
                event_offset_seconds=3,
                symbol="BTCUSD",
                quantity="-0.02",
                price="110",
                net_amount="-0.25",
            ),
        ]
    )

    assert result.comparison.equivalent
    assert cash(result.independent) == Decimal("899.75")
    btc = position(result.independent, "BTCUSD")
    assert btc is not None
    assert btc.quantity == Decimal("0.99")
    assert btc.signed_cost == Decimal("99")
    assert result.independent.realized_pnl == Decimal("0.1")
    assert result.independent.fees == Decimal("1.35")


def test_date_only_crypto_fee_orders_after_same_day_timestamped_fill() -> None:
    fee = replace(
        activity(
            "date-only-fee",
            "CFEE",
            symbol="BTCUSD",
            quantity="-0.01",
            price="110",
            net_amount="0",
        ),
        event_at=None,
    )
    fill = activity(
        "timestamped-fill",
        "FILL",
        event_offset_seconds=1,
        symbol="BTCUSD",
        side="buy",
        quantity="1",
        price="100",
        net_amount=None,
    )

    result = reduce_and_compare([fee, fill])

    assert fee.economic_at > fill.economic_at
    assert result.admissible
    assert result.comparison.equivalent
    btc = position(result.independent, "BTCUSD")
    assert btc is not None
    assert btc.quantity == Decimal("0.99")
    assert btc.signed_cost == Decimal("99")
    assert result.independent.fees == Decimal("1.1")


def test_crypto_fee_underflow_is_rejected_by_both_reducers() -> None:
    activities = [
        activity(
            "btc-buy",
            "FILL",
            symbol="BTCUSD",
            side="buy",
            quantity="1",
            price="1",
            net_amount=None,
        ),
        activity(
            "tiny-asset-fee",
            "CFEE",
            event_offset_seconds=1,
            symbol="BTCUSD",
            quantity="-0.000000000000000001",
            price="0.000000000000000001",
            net_amount="0",
        ),
    ]

    for reducer in (reduce_balanced_journal, reduce_independent_state):
        with pytest.raises(
            EconomicLedgerError,
            match="economic_crypto_fee_fair_value_below_ledger_quantum",
        ):
            reducer(activities)


@pytest.mark.parametrize("quantity", [None, "0", "0.01"])
def test_zero_cash_crypto_fee_without_negative_asset_charge_fails_closed(
    quantity: str | None,
) -> None:
    result = reduce_and_compare(
        [
            activity(
                "invalid-crypto-fee",
                "CFEE",
                quantity=quantity,
                net_amount="0",
            )
        ]
    )

    assert result.comparison.equivalent
    assert not result.admissible
    assert result.journal.projection.unsupported_activity_ids == ("invalid-crypto-fee",)
    assert result.independent.unsupported_activity_ids == ("invalid-crypto-fee",)
    assert result.journal.transactions == ()


def test_repeating_cost_side_flips_use_one_released_cost_rounding_order() -> None:
    fills = (
        ("buy", "1", "1"),
        ("buy", "6", "1"),
        ("sell", "25", "19"),
        ("sell", "3", "8"),
        ("sell", "16", "1"),
        ("buy", "21", "1"),
        ("sell", "1", "1"),
        ("sell", "2", "1"),
        ("sell", "25", "1"),
        ("buy", "22", "2"),
    )
    rows = [activity("capital", "JNLC", net_amount="1000000")]
    rows.extend(
        activity(
            f"rounding-fill-{index}",
            "FILL",
            event_offset_seconds=index + 1,
            symbol="AAPL",
            side=side,
            quantity=quantity,
            price=price,
            net_amount=None,
        )
        for index, (side, quantity, price) in enumerate(fills)
    )

    result = reduce_and_compare(rows)

    assert result.admissible
    assert result.comparison.equivalent
    aapl = position(result.independent, "AAPL")
    assert aapl is not None
    assert aapl.signed_cost == Decimal("-96.594594594594594594")
    assert result.independent.realized_pnl == Decimal("374.405405405405405406")


@pytest.mark.parametrize("activity_type", ["FILL", "CFEE"])
def test_trade_and_crypto_fee_reject_non_quote_currency(
    activity_type: str,
) -> None:
    opening = activity(
        "btc-buy",
        "FILL",
        symbol="BTCUSD",
        side="buy",
        quantity="1",
        price="100",
        net_amount=None,
    )
    contradictory = activity(
        "contradictory-currency",
        activity_type,
        event_offset_seconds=1,
        symbol="BTCUSD",
        side="buy" if activity_type == "FILL" else None,
        quantity="0.01" if activity_type == "FILL" else "-0.01",
        price="100",
        net_amount=None if activity_type == "FILL" else "0",
        currency="EUR",
    )

    with pytest.raises(EconomicLedgerError, match="currency_unsupported"):
        reduce_and_compare([opening, contradictory])


def test_split_without_golden_broker_fixture_fails_closed() -> None:
    result = reduce_and_compare(
        [
            activity("deposit", "JNLC", net_amount="1000"),
            activity(
                "buy",
                "FILL",
                symbol="MU",
                side="buy",
                quantity="10",
                price="10",
                net_amount=None,
            ),
            activity("split", "SSP", symbol="MU", quantity="10", net_amount="0"),
        ]
    )

    assert result.comparison.equivalent
    assert result.admissible is False
    assert result.journal.projection.unsupported_activity_ids == ("split",)
    assert result.independent.unsupported_activity_ids == ("split",)
    mu = position(result.independent, "MU")
    assert mu is not None
    assert mu.quantity == Decimal("10")
    assert mu.signed_cost == Decimal("100")
    assert mu.average_cost == Decimal("10")


def test_paired_reverse_split_remove_and_add_rows_fail_closed() -> None:
    result = reduce_and_compare(
        [
            activity(
                "mu-buy",
                "FILL",
                symbol="MU",
                side="buy",
                quantity="10",
                price="10",
                net_amount=None,
            ),
            activity(
                "reverse-split-remove",
                "SSP",
                subtype="remove",
                event_offset_seconds=1,
                symbol="MU",
                quantity="-10",
                net_amount="0",
            ),
            activity(
                "reverse-split-add",
                "SSP",
                subtype="add",
                event_offset_seconds=2,
                symbol="MU",
                quantity="1",
                net_amount="0",
            ),
        ]
    )

    assert result.comparison.equivalent
    assert result.admissible is False
    assert result.journal.projection.unsupported_activity_ids == (
        "reverse-split-add",
        "reverse-split-remove",
    )
    assert result.independent.unsupported_activity_ids == (
        "reverse-split-add",
        "reverse-split-remove",
    )
    mu = position(result.independent, "MU")
    assert mu is not None
    assert mu.quantity == Decimal("10")
    assert mu.signed_cost == Decimal("100")
    assert mu.average_cost == Decimal("10")


def test_retroactive_correction_reverses_original_then_applies_replacement() -> None:
    original = activity(
        "original-fill",
        "FILL",
        event_offset_seconds=1,
        symbol="AVGO",
        side="buy",
        quantity="1",
        price="100",
        net_amount=None,
    )
    correction = activity(
        "corrected-fill",
        "FILL",
        correction_of="original-fill",
        event_offset_seconds=10,
        symbol="AVGO",
        side="buy",
        quantity="1",
        price="90",
        net_amount=None,
    )
    result = reduce_and_compare(
        [activity("deposit", "CSD", net_amount="1000"), original, correction]
    )

    assert result.comparison.equivalent
    assert result.journal.projection.corrected_count == 1
    assert cash(result.independent) == Decimal("910")
    avgo = position(result.independent, "AVGO")
    assert avgo is not None and avgo.signed_cost == Decimal("90")
    reversal = next(
        transaction
        for transaction in result.journal.transactions
        if transaction.posting_rule == "correction_reversal"
    )
    original_transaction = next(
        transaction
        for transaction in result.journal.transactions
        if transaction.transaction_id == "original-fill"
    )
    assert reversal.reverses_transaction_id == original_transaction.transaction_id
    assert tuple(line.amount for line in reversal.lines) == tuple(
        -line.amount for line in original_transaction.lines
    )


def test_correction_reversal_id_is_bounded_for_maximum_valid_broker_ids() -> None:
    original_id = "o" * 256
    correction_id = "c" * 256
    result = reduce_and_compare(
        [
            activity(
                original_id,
                "FILL",
                symbol="AVGO",
                side="buy",
                quantity="1",
                price="100",
                net_amount=None,
            ),
            activity(
                correction_id,
                "FILL",
                correction_of=original_id,
                event_offset_seconds=1,
                symbol="AVGO",
                side="buy",
                quantity="1",
                price="90",
                net_amount=None,
            ),
        ]
    )

    reversal = next(
        transaction
        for transaction in result.journal.transactions
        if transaction.posting_rule == "correction_reversal"
    )
    readable = f"{correction_id}:reversal:{original_id}"
    expected_digest = hashlib.sha256(readable.encode("utf-8")).hexdigest()
    assert reversal.transaction_id == f"correction-reversal:sha256:{expected_digest}"
    assert len(reversal.transaction_id) <= 512
    assert reversal.reverses_transaction_id == original_id
    assert result.comparison.equivalent


def test_correction_replaces_the_root_at_its_original_economic_order_slot() -> None:
    result = reduce_and_compare(
        [
            activity(
                "original-buy",
                "FILL",
                event_offset_seconds=1,
                symbol="AVGO",
                side="buy",
                quantity="1",
                price="10",
                net_amount=None,
            ),
            activity(
                "interposed-sell",
                "FILL",
                event_offset_seconds=2,
                symbol="AVGO",
                side="sell",
                quantity="1",
                price="20",
                net_amount=None,
            ),
            activity(
                "corrected-buy",
                "FILL",
                correction_of="original-buy",
                event_offset_seconds=3,
                symbol="AVGO",
                side="buy",
                quantity="2",
                price="10",
                net_amount=None,
            ),
        ]
    )

    avgo = position(result.independent, "AVGO")
    assert avgo is not None
    assert avgo.quantity == Decimal("1")
    assert avgo.signed_cost == Decimal("10")
    assert result.independent.realized_pnl == Decimal("10")
    assert [
        transaction.transaction_id for transaction in result.journal.transactions
    ] == [
        "original-buy",
        "corrected-buy:reversal:original-buy",
        "corrected-buy",
        "interposed-sell",
    ]
    assert result.comparison.equivalent


def test_identical_duplicates_collapse_but_changed_bytes_fail() -> None:
    fill = activity(
        "fill",
        "FILL",
        symbol="AAPL",
        side="buy",
        quantity="1",
        price="10",
        net_amount=None,
    )
    result = reduce_and_compare([fill, fill])
    assert result.journal.projection.input_count == 1
    assert result.journal.projection.duplicate_count == 1

    changed = activity(
        "fill",
        "FILL",
        symbol="AAPL",
        side="buy",
        quantity="1",
        price="10",
        net_amount=None,
        raw_payload_sha256="b" * 64,
    )
    with pytest.raises(EconomicLedgerSourceContradiction):
        prepare_activities([fill, changed])


def test_correction_graph_rejects_missing_fork_and_cycle() -> None:
    root = activity("root", "DIV", net_amount="1")
    missing = activity("missing", "DIV", correction_of="absent", net_amount="2")
    with pytest.raises(EconomicLedgerCorrectionError, match="predecessor_missing"):
        prepare_activities([root, missing])

    left = activity("left", "DIV", correction_of="root", net_amount="2")
    right = activity("right", "DIV", correction_of="root", net_amount="3")
    with pytest.raises(EconomicLedgerCorrectionError, match="correction_fork"):
        prepare_activities([root, left, right])

    cycle_a = activity("cycle-a", "DIV", correction_of="cycle-b", net_amount="1")
    cycle_b = activity("cycle-b", "DIV", correction_of="cycle-a", net_amount="2")
    with pytest.raises(EconomicLedgerCorrectionError, match="correction_cycle"):
        prepare_activities([cycle_a, cycle_b])


def test_unknown_activity_is_visible_and_non_admissible() -> None:
    result = reduce_and_compare(
        [activity("assignment", "OPASN", symbol="AAPL260117C00100000")]
    )
    assert result.comparison.equivalent
    assert not result.admissible
    assert result.independent.unsupported_activity_ids == ("assignment",)


def test_split_with_cash_component_fails_closed_in_both_reducers() -> None:
    result = reduce_and_compare(
        [
            activity("deposit", "CSD", net_amount="100"),
            activity(
                "buy",
                "FILL",
                event_offset_seconds=1,
                symbol="AAPL",
                side="buy",
                quantity="1",
                price="100",
                net_amount=None,
            ),
            activity(
                "cash-in-lieu",
                "SSP",
                event_offset_seconds=2,
                symbol="AAPL",
                quantity="1",
                net_amount="-0.25",
            ),
        ]
    )

    assert result.comparison.equivalent
    assert not result.admissible
    assert result.journal.projection.unsupported_activity_ids == ("cash-in-lieu",)
    assert result.independent.unsupported_activity_ids == ("cash-in-lieu",)
    assert cash(result.journal.projection) == Decimal("0")
    aapl = position(result.journal.projection, "AAPL")
    assert aapl is not None
    assert aapl.quantity == Decimal("1")


def test_fill_with_broker_cash_component_fails_closed_in_both_reducers() -> None:
    result = reduce_and_compare(
        [
            activity("deposit", "CSD", net_amount="100"),
            activity(
                "net-fill",
                "FILL",
                event_offset_seconds=1,
                symbol="AAPL",
                side="buy",
                quantity="1",
                price="10",
                net_amount="-11",
            ),
        ]
    )

    assert result.comparison.equivalent
    assert not result.admissible
    assert result.journal.projection.unsupported_activity_ids == ("net-fill",)
    assert result.independent.unsupported_activity_ids == ("net-fill",)
    assert cash(result.journal.projection) == Decimal("100")
    assert position(result.journal.projection, "AAPL") is None


def test_input_order_does_not_change_manifest_or_results() -> None:
    rows = [
        activity("deposit", "CSD", event_offset_seconds=0, net_amount="100"),
        activity("fee", "FEE", event_offset_seconds=2, net_amount="-1"),
        activity("dividend", "DIV", event_offset_seconds=1, net_amount="2"),
    ]
    ordered = reduce_and_compare(rows)
    shuffled = reduce_and_compare([rows[2], rows[0], rows[1]])
    assert (
        ordered.journal.projection.result_digest
        == shuffled.journal.projection.result_digest
    )
    assert ordered.independent.result_digest == shuffled.independent.result_digest
    assert ordered.journal.journal_digest == shuffled.journal.journal_digest


def test_transaction_constructor_rejects_an_unbalanced_commodity() -> None:
    with pytest.raises(EconomicLedgerError, match="unbalanced"):
        LedgerTransaction(
            transaction_id="bad",
            source_activity_id="bad",
            posting_rule="bad",
            lines=(
                LedgerLine(account="asset:cash", commodity="USD", amount=Decimal("1")),
                LedgerLine(
                    account="income:test", commodity="USD", amount=Decimal("-0.5")
                ),
            ),
        )
