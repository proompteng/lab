from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

import pytest

from app.trading.economic_ledger import (
    EconomicLedgerError,
    prepare_activities,
    reduce_balanced_journal,
    reduce_and_compare,
    reduce_independent_state,
)
from tests.economic_ledger.support import BASE_TIME, activity


def test_late_date_only_crypto_fee_preserves_existing_transaction_digests() -> None:
    fills = [
        activity(
            "fill-1",
            "FILL",
            event_offset_seconds=1,
            symbol="BTCUSD",
            side="buy",
            quantity="0.1",
            price="1",
            net_amount=None,
        ),
        activity(
            "fill-2",
            "FILL",
            event_offset_seconds=2,
            symbol="BTCUSD",
            side="buy",
            quantity="0.1",
            price="3.333333333333333333",
            net_amount=None,
        ),
    ]
    existing_fee = replace(
        activity(
            "z-existing-fee",
            "CFEE",
            symbol="BTCUSD",
            quantity="-0.07",
            price="3",
            net_amount="0",
        ),
        event_at=None,
    )
    late_fee = replace(
        activity(
            "a-late-fee",
            "CFEE",
            symbol="BTCUSD",
            quantity="-0.01",
            price="4",
            net_amount="0",
        ),
        event_at=None,
        first_observed_at=existing_fee.first_observed_at + timedelta(minutes=1),
    )

    before_prepared = prepare_activities([*fills, existing_fee])
    after_prepared = prepare_activities(
        [*fills, existing_fee, late_fee],
        prior_activity_order=before_prepared.activity_order,
    )
    before = reduce_and_compare(before_prepared)
    after = reduce_and_compare(after_prepared)
    before_digests = {
        transaction.transaction_id: transaction.digest
        for transaction in before.journal.transactions
    }
    after_digests = {
        transaction.transaction_id: transaction.digest
        for transaction in after.journal.transactions
    }

    assert existing_fee.external_activity_id > late_fee.external_activity_id
    assert existing_fee.sort_key < late_fee.sort_key
    assert before.admissible and after.admissible
    assert before.comparison.equivalent and after.comparison.equivalent
    assert before_digests.items() <= after_digests.items()


def test_late_prior_date_crypto_fee_preserves_existing_transaction_digests() -> None:
    prior_day = BASE_TIME - timedelta(days=1)
    fills = [
        replace(
            activity(
                "fill-1",
                "FILL",
                symbol="BTCUSD",
                side="buy",
                quantity="0.1",
                price="1",
                net_amount=None,
            ),
            event_at=prior_day + timedelta(seconds=1),
            settle_date=prior_day.date(),
        ),
        replace(
            activity(
                "fill-2",
                "FILL",
                symbol="BTCUSD",
                side="buy",
                quantity="0.1",
                price="3.333333333333333333",
                net_amount=None,
            ),
            event_at=prior_day + timedelta(seconds=2),
            settle_date=prior_day.date(),
        ),
    ]
    existing_fee = replace(
        activity(
            "existing-later-date-fee",
            "CFEE",
            symbol="BTCUSD",
            quantity="-0.07",
            price="3",
            net_amount="0",
        ),
        event_at=None,
        first_observed_at=BASE_TIME + timedelta(days=1),
    )
    late_prior_date_fee = replace(
        activity(
            "late-prior-date-fee",
            "CFEE",
            symbol="BTCUSD",
            quantity="-0.01",
            price="4",
            net_amount="0",
        ),
        event_at=None,
        settle_date=prior_day.date(),
        first_observed_at=BASE_TIME + timedelta(days=2),
    )

    before_prepared = prepare_activities([*fills, existing_fee])
    after_prepared = prepare_activities(
        [*fills, existing_fee, late_prior_date_fee],
        prior_activity_order=before_prepared.activity_order,
    )
    before = reduce_and_compare(before_prepared)
    after = reduce_and_compare(after_prepared)
    before_digests = {
        transaction.transaction_id: transaction.digest
        for transaction in before.journal.transactions
    }
    after_digests = {
        transaction.transaction_id: transaction.digest
        for transaction in after.journal.transactions
    }

    assert late_prior_date_fee.sort_key < existing_fee.sort_key
    assert after_prepared.activity_order[-1] == late_prior_date_fee.external_activity_id
    assert before.admissible and after.admissible
    assert before.comparison.equivalent and after.comparison.equivalent
    assert before_digests.items() <= after_digests.items()


def test_initial_backfill_keeps_new_rows_in_economic_order() -> None:
    prior_day = BASE_TIME - timedelta(days=1)
    prior_fill = replace(
        activity(
            "prior-fill",
            "FILL",
            symbol="BTCUSD",
            side="buy",
            quantity="0.1",
            price="10",
            net_amount=None,
        ),
        event_at=prior_day + timedelta(seconds=1),
        settle_date=prior_day.date(),
    )
    historical_fee = replace(
        activity(
            "historical-fee",
            "CFEE",
            symbol="BTCUSD",
            quantity="-0.01",
            price="10",
            net_amount="0",
        ),
        event_at=None,
        settle_date=prior_day.date(),
        first_observed_at=BASE_TIME + timedelta(days=2),
    )
    later_fill = activity(
        "later-fill",
        "FILL",
        event_offset_seconds=1,
        symbol="BTCUSD",
        side="buy",
        quantity="0.1",
        price="11",
        net_amount=None,
    )

    prepared = prepare_activities([later_fill, historical_fee, prior_fill])
    reduction = reduce_and_compare(prepared)

    assert prepared.activity_order == (
        prior_fill.external_activity_id,
        historical_fee.external_activity_id,
        later_fill.external_activity_id,
    )
    assert reduction.admissible
    assert reduction.comparison.equivalent


def test_published_order_anchor_fails_closed_when_duplicate_or_missing() -> None:
    only = activity("only", "CSD", net_amount="1")

    with pytest.raises(
        EconomicLedgerError,
        match="economic_ledger_prior_activity_order_duplicate",
    ):
        prepare_activities([only], prior_activity_order=("only", "only"))
    with pytest.raises(
        EconomicLedgerError,
        match="economic_ledger_prior_activity_missing",
    ):
        prepare_activities([only], prior_activity_order=("missing",))


def test_published_order_anchor_rejects_unsafe_retroactive_facts() -> None:
    existing = activity("existing", "CSD", net_amount="1")
    retroactive_fill = replace(
        activity(
            "retroactive-fill",
            "FILL",
            symbol="BTCUSD",
            side="buy",
            quantity="0.1",
            price="1",
            net_amount=None,
        ),
        event_at=BASE_TIME - timedelta(days=1),
        settle_date=(BASE_TIME - timedelta(days=1)).date(),
    )
    correction = activity(
        "correction",
        "CSD",
        correction_of="existing",
        net_amount="2",
    )

    with pytest.raises(
        EconomicLedgerError,
        match="economic_ledger_retroactive_activity_requires_new_version",
    ):
        prepare_activities(
            [existing, retroactive_fill],
            prior_activity_order=("existing",),
        )
    with pytest.raises(
        EconomicLedgerError,
        match="economic_ledger_retroactive_correction_requires_new_version",
    ):
        prepare_activities(
            [existing, correction],
            prior_activity_order=("existing",),
        )


def test_unappendable_late_fee_requires_new_projection_version() -> None:
    prior_day = BASE_TIME - timedelta(days=1)
    buy = replace(
        activity(
            "buy",
            "FILL",
            symbol="BTCUSD",
            side="buy",
            quantity="0.1",
            price="10",
            net_amount=None,
        ),
        event_at=prior_day + timedelta(seconds=1),
        settle_date=prior_day.date(),
    )
    sell = activity(
        "sell",
        "FILL",
        event_offset_seconds=1,
        symbol="BTCUSD",
        side="sell",
        quantity="0.1",
        price="11",
        net_amount=None,
    )
    late_fee = replace(
        activity(
            "late-fee",
            "CFEE",
            symbol="BTCUSD",
            quantity="-0.01",
            price="10",
            net_amount="0",
        ),
        event_at=None,
        settle_date=prior_day.date(),
        first_observed_at=BASE_TIME + timedelta(days=1),
    )
    published = prepare_activities([buy, sell])
    replay = prepare_activities(
        [buy, sell, late_fee],
        prior_activity_order=published.activity_order,
    )

    assert replay.retroactive_append_ids == (late_fee.external_activity_id,)
    for reducer in (reduce_balanced_journal, reduce_independent_state):
        with pytest.raises(
            EconomicLedgerError,
            match="economic_ledger_unappendable_late_fee_requires_new_version",
        ):
            reducer(replay)
