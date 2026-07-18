from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from app.trading.economic_ledger import reduce_and_compare
from tests.economic_ledger.support import activity


def test_late_date_only_crypto_fee_preserves_existing_transaction_digest() -> None:
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

    before = reduce_and_compare([*fills, existing_fee])
    after = reduce_and_compare([*fills, existing_fee, late_fee])
    before_digest = next(
        transaction.digest
        for transaction in before.journal.transactions
        if transaction.source_activity_id == existing_fee.external_activity_id
    )
    after_digest = next(
        transaction.digest
        for transaction in after.journal.transactions
        if transaction.source_activity_id == existing_fee.external_activity_id
    )

    assert existing_fee.external_activity_id > late_fee.external_activity_id
    assert existing_fee.sort_key < late_fee.sort_key
    assert before.admissible and after.admissible
    assert before.comparison.equivalent and after.comparison.equivalent
    assert after_digest == before_digest
