from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.trading.broker_mutation_receipts import (
    BrokerMutationRecoveryAcquireOptions,
    acquire_linked_submission_recovery,
)
from tests.execution.linked_submission_recovery_postgres_support import (
    RecoveryHarness,
    build_recovery_harness,
    enter_linked_io,
    force_linked_recovery_due,
)


@pytest.fixture
def recovery_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[RecoveryHarness]:
    yield from build_recovery_harness(monkeypatch)


def _shift_claim_recovery_after(
    session: Session,
    *,
    decision_id: uuid.UUID,
) -> None:
    session.execute(
        text(
            "ALTER TABLE trade_decision_submission_claims "
            "DISABLE TRIGGER trg_guard_td_submission_claim_0061_update"
        )
    )
    session.execute(
        text(
            "UPDATE trade_decision_submission_claims "
            "SET recovery_after = recovery_after + interval '1 minute' "
            "WHERE trade_decision_id = :decision_id"
        ),
        {"decision_id": decision_id},
    )
def _enable_claim_guard(session: Session) -> None:
    session.execute(
        text(
            "ALTER TABLE trade_decision_submission_claims "
            "ENABLE TRIGGER trg_guard_td_submission_claim_0061_update"
        )
    )


def test_0062_deferred_guard_rejects_asymmetric_recovery_after(
    recovery_harness: RecoveryHarness,
) -> None:
    fixture, _ = enter_linked_io(recovery_harness)

    with recovery_harness.sessions() as session:
        _shift_claim_recovery_after(
            session,
            decision_id=fixture.decision_id,
        )
        with pytest.raises(
            DBAPIError,
            match="linked nonterminal recovery state is asymmetric",
        ):
            session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        session.rollback()


def test_0062_upgrade_rejects_asymmetric_recovery_after(
    recovery_harness: RecoveryHarness,
) -> None:
    fixture, _ = enter_linked_io(recovery_harness)
    command.downgrade(
        recovery_harness.alembic,
        "0061_linked_submission_terminal",
    )
    with recovery_harness.sessions() as session:
        _shift_claim_recovery_after(
            session,
            decision_id=fixture.decision_id,
        )
        session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        _enable_claim_guard(session)
        session.commit()

    with pytest.raises(
        DBAPIError,
        match="refusing to upgrade asymmetric linked submission recovery state",
    ):
        command.upgrade(
            recovery_harness.alembic,
            "0062_linked_submission_recovery",
        )
    with recovery_harness.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
            == "0061_linked_submission_terminal"
        )


def test_0062_downgrade_rejects_active_linked_recovery(
    recovery_harness: RecoveryHarness,
) -> None:
    fixture, acquired = enter_linked_io(recovery_harness)
    force_linked_recovery_due(
        recovery_harness,
        fixture=fixture,
        receipt_id=acquired.receipt.receipt_id,
    )
    with recovery_harness.sessions() as session:
        recovery = acquire_linked_submission_recovery(
            session,
            receipt_id=acquired.receipt.receipt_id,
            recovery_owner="reconciler-a",
            writer_generation=7,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    assert recovery.outcome == "acquired"

    with pytest.raises(
        DBAPIError,
        match="refusing to downgrade linked recovery state",
    ):
        command.downgrade(
            recovery_harness.alembic,
            "0061_linked_submission_terminal",
        )
    with recovery_harness.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
            == "0062_linked_submission_recovery"
        )
