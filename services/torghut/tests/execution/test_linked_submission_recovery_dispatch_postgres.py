from __future__ import annotations

from collections.abc import Iterator

import pytest

from app.trading.broker_mutation_receipts import (
    BrokerMutationReceiptAcquireOptions,
    acquire_broker_mutation_receipt,
    acquire_linked_submission_recovery,
    list_due_broker_mutation_receipt_ids,
    release_broker_mutation_receipt,
)
from tests.execution.linked_submission_recovery_postgres_support import (
    RecoveryHarness,
    build_recovery_harness,
    enter_linked_io,
    force_linked_recovery_due,
)
from tests.execution.test_broker_mutation_linked_receipts_postgres import (
    create_linked_submit_fixture,
)


@pytest.fixture
def recovery_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[RecoveryHarness]:
    yield from build_recovery_harness(monkeypatch)


@pytest.mark.parametrize("receipt_state", ["claimed", "released"])
def test_linked_receipt_before_broker_io_does_not_require_recovery(
    recovery_harness: RecoveryHarness,
    receipt_state: str,
) -> None:
    fixture = create_linked_submit_fixture(recovery_harness.engine)
    with recovery_harness.sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=fixture.intent,
            primary_owner=fixture.claim_handle.claim_owner,
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                submission_claim_handle=fixture.claim_handle,
            ),
        )
    receipt = acquired.receipt
    if receipt_state == "released":
        with recovery_harness.sessions() as session:
            receipt = release_broker_mutation_receipt(
                session,
                handle=receipt.primary_handle,
                reason="broker call not started",
            )
    assert receipt.state == receipt_state

    with recovery_harness.sessions() as session:
        recovery = acquire_linked_submission_recovery(
            session,
            receipt_id=acquired.receipt.receipt_id,
            recovery_owner="reconciler-a",
            writer_generation=7,
        )

    assert recovery.outcome == "not_required"
    assert recovery.receipt == receipt
    assert recovery.submission_claim is None


def test_generic_due_recovery_scan_excludes_linked_receipts(
    recovery_harness: RecoveryHarness,
) -> None:
    fixture, acquired = enter_linked_io(recovery_harness)
    force_linked_recovery_due(
        recovery_harness,
        fixture=fixture,
        receipt_id=acquired.receipt.receipt_id,
    )

    with recovery_harness.sessions() as session:
        assert list_due_broker_mutation_receipt_ids(session) == ()
