from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, BrokerMutationReceiptEvent
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationIntent,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptAcquireResult,
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptValidationError,
    BrokerMutationReceiptSnapshot,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryHandle,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    acquire_broker_mutation_recovery,
    broker_mutation_runtime_result,
    build_broker_mutation_intent,
    build_broker_mutation_recovery_observation,
    build_broker_mutation_settlement,
    get_broker_mutation_receipt,
    get_broker_mutation_receipt_history,
    list_due_broker_mutation_receipt_ids,
    mark_broker_mutation_io_started,
    record_broker_mutation_recovery_observation,
    release_broker_mutation_receipt,
    release_broker_mutation_recovery,
    renew_broker_mutation_receipt,
    renew_broker_mutation_recovery,
    settle_broker_mutation_preflight,
    settle_broker_mutation_primary,
    settle_broker_mutation_recovery,
)


def _sessions(database_path: Path) -> sessionmaker[Session]:
    engine = create_engine(
        f"sqlite+pysqlite:///{database_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
        future=True,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )


def _intent(client_request_id: str) -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint="a" * 64,
            operation="cancel_order",
            risk_class="risk_neutral",
            purpose="operator",
            workflow_id=f"workflow/{client_request_id}",
            client_request_id=client_request_id,
            target=BrokerMutationTarget(kind="order", key=f"order/{client_request_id}"),
            request_payload={"client_request_id": client_request_id},
        )
    )


def _acquire(
    session: Session,
    client_request_id: str,
    *,
    owner: str = "writer-a",
    generation: int = 1,
    token: uuid.UUID | None = None,
) -> BrokerMutationReceiptAcquireResult:
    return acquire_broker_mutation_receipt(
        session,
        intent=_intent(client_request_id),
        primary_owner=owner,
        writer_generation=generation,
        options=BrokerMutationReceiptAcquireOptions(
            primary_token=token,
            lease_seconds=30,
        ),
    )


def _force_recovery_due(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> None:
    with sessions() as session:
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        latest.recovery_after = datetime(2000, 1, 1, tzinfo=timezone.utc)
        if latest.recovery_lease_expires_at is not None:
            latest.recovery_lease_started_at = datetime(
                1999,
                12,
                31,
                tzinfo=timezone.utc,
            )
            latest.recovery_lease_expires_at = datetime(
                2000,
                1,
                1,
                tzinfo=timezone.utc,
            )
        session.commit()


def _recovery_handle(
    snapshot: BrokerMutationReceiptSnapshot,
) -> BrokerMutationRecoveryHandle:
    handle = snapshot.recovery_handle
    assert handle is not None
    return handle


@dataclass(frozen=True, slots=True)
class _RecoveryFixture:
    receipt_id: uuid.UUID
    primary_handle: BrokerMutationReceiptHandle
    recovery_handle: BrokerMutationRecoveryHandle


def _start_due_recovery(
    sessions: sessionmaker[Session],
    client_request_id: str,
) -> _RecoveryFixture:
    with sessions() as session:
        acquired = _acquire(session, client_request_id, token=uuid.uuid4())
    primary_handle = acquired.receipt.primary_handle
    with sessions() as session:
        io_start = mark_broker_mutation_io_started(
            session,
            handle=primary_handle,
            recovery_seconds=30,
        )
    assert io_start.authorized
    receipt_id = io_start.receipt.receipt_id
    _force_recovery_due(sessions, receipt_id)
    with sessions() as session:
        assert list_due_broker_mutation_receipt_ids(session) == (receipt_id,)
    with sessions() as session:
        recovery = acquire_broker_mutation_recovery(
            session,
            receipt_id=receipt_id,
            recovery_owner="reader-a",
            writer_generation=10,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    assert recovery.outcome == "acquired"
    assert recovery.receipt is not None
    return _RecoveryFixture(
        receipt_id=receipt_id,
        primary_handle=primary_handle,
        recovery_handle=_recovery_handle(recovery.receipt),
    )


def test_primary_acquisition_renew_release_and_reacquire(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "primary.sqlite")
    token_a = uuid.uuid4()
    token_b = uuid.uuid4()
    with sessions() as session:
        first = _acquire(session, "cancel-1", token=token_a)
    assert first.outcome == "acquired"
    handle_a = first.receipt.primary_handle

    with sessions() as session:
        same = _acquire(session, "cancel-1", token=token_a)
    assert same.outcome == "already_owned"
    with sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptConflictError,
            match="primary_identity_conflict",
        ):
            _acquire(
                session,
                "cancel-1",
                owner="writer-b",
                generation=2,
                token=token_a,
            )
    with sessions() as session:
        busy = _acquire(
            session,
            "cancel-1",
            owner="writer-b",
            generation=2,
            token=token_b,
        )
    assert busy.outcome == "busy"

    with sessions() as session:
        renewed = renew_broker_mutation_receipt(
            session,
            handle=handle_a,
            lease_seconds=60,
        )
    assert renewed.lifecycle.event_type == "primary_renewed"
    with sessions() as session:
        released = release_broker_mutation_receipt(
            session,
            handle=handle_a,
            reason="worker_shutdown",
        )
    assert released.state == "released"
    with sessions() as session:
        idempotent_release = release_broker_mutation_receipt(
            session,
            handle=handle_a,
            reason="worker_shutdown",
        )
    assert idempotent_release.lifecycle.sequence_no == released.lifecycle.sequence_no

    with sessions() as session:
        with pytest.raises(BrokerMutationReceiptFenceError):
            renew_broker_mutation_receipt(session, handle=handle_a)
    with sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptConflictError,
            match="primary_token_reuse",
        ):
            _acquire(session, "cancel-1", token=token_a)
    with sessions() as session:
        reacquired = _acquire(
            session,
            "cancel-1",
            owner="writer-b",
            generation=2,
            token=token_b,
        )
    assert reacquired.outcome == "acquired"
    assert reacquired.receipt.primary_handle.primary_epoch == 2
    assert reacquired.receipt.primary_handle.primary_token == token_b
    assert reacquired.receipt.primary_handle.primary_owner == "writer-b"
    assert reacquired.receipt.primary_handle.primary_writer_generation == 2
    assert reacquired.receipt.lifecycle.event_type == "primary_claimed"
    assert reacquired.receipt.lifecycle.event_writer_generation == 2
    assert reacquired.receipt.lifecycle.released_at is None
    assert reacquired.receipt.lifecycle.release_reason is None

    with sessions() as session:
        history = get_broker_mutation_receipt_history(
            session,
            first.receipt.receipt_id,
        )
    assert [event.event_type for event in history] == [
        "primary_claimed",
        "primary_renewed",
        "primary_released",
        "primary_claimed",
    ]


def test_preflight_settlement_never_fabricates_broker_io(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "preflight.sqlite")
    with sessions() as session:
        acquired = _acquire(session, "cancel-preflight", token=uuid.uuid4())
    settlement = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="preflight",
            outcome="already_satisfied",
            broker_reference=None,
            execution_id=None,
            evidence_payload={"broker_state": "already_canceled"},
        )
    )
    with sessions() as session:
        settled = settle_broker_mutation_preflight(
            session,
            handle=acquired.receipt.primary_handle,
            settlement=settlement,
        )

    assert settled.state == "settled"
    assert settled.lifecycle.broker_io_started_at is None
    assert settled.settlement.outcome == "already_satisfied"
    assert broker_mutation_runtime_result(settled) == "already_processed"


def test_broker_io_is_irreversible_and_primary_settlement_is_idempotent(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "primary-terminal.sqlite")
    with sessions() as session:
        acquired = _acquire(session, "cancel-terminal", token=uuid.uuid4())
    primary = acquired.receipt.primary_handle
    with sessions() as session:
        io_start = mark_broker_mutation_io_started(
            session,
            handle=primary,
            recovery_seconds=30,
        )
    assert io_start.authorized
    assert io_start.permit is not None
    assert io_start.permit.receipt_id == primary.receipt_id
    broker_io = io_start.receipt
    assert broker_io.state == "broker_io"
    with sessions() as session:
        repeated_boundary = mark_broker_mutation_io_started(session, handle=primary)
    assert not repeated_boundary.authorized
    assert repeated_boundary.outcome == "already_started"
    assert repeated_boundary.permit is None
    assert (
        repeated_boundary.receipt.lifecycle.sequence_no
        == broker_io.lifecycle.sequence_no
    )
    with sessions() as session:
        active = _acquire(
            session,
            "cancel-terminal",
            owner="writer-b",
            generation=2,
            token=uuid.uuid4(),
        )
    assert active.outcome == "busy"
    _force_recovery_due(sessions, broker_io.receipt_id)
    with sessions() as session:
        recovery_due = _acquire(
            session,
            "cancel-terminal",
            owner="writer-b",
            generation=2,
            token=uuid.uuid4(),
        )
    assert recovery_due.outcome == "recovery_required"
    with sessions() as session:
        with pytest.raises(BrokerMutationReceiptFenceError):
            release_broker_mutation_receipt(
                session,
                handle=primary,
                reason="unsafe_release",
            )

    acknowledged = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference="broker-order-1",
            execution_id=None,
            evidence_payload={"broker_status": "accepted"},
        )
    )
    with sessions() as session:
        settled = settle_broker_mutation_primary(
            session,
            handle=primary,
            settlement=acknowledged,
        )
    assert broker_mutation_runtime_result(settled) == "submitted"
    with sessions() as session:
        idempotent = settle_broker_mutation_primary(
            session,
            handle=primary,
            settlement=acknowledged,
        )
    assert idempotent.lifecycle.sequence_no == settled.lifecycle.sequence_no
    with sessions() as session:
        terminal = _acquire(
            session,
            "cancel-terminal",
            owner="writer-b",
            generation=2,
            token=uuid.uuid4(),
        )
    assert terminal.outcome == "settled"
    assert terminal.receipt.lifecycle.sequence_no == settled.lifecycle.sequence_no

    rejected = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="rejected",
            broker_reference=None,
            execution_id=None,
            evidence_payload={"broker_status": "rejected"},
        )
    )
    with sessions() as session:
        with pytest.raises(BrokerMutationReceiptConflictError):
            settle_broker_mutation_primary(
                session,
                handle=primary,
                settlement=rejected,
            )


def test_recovery_observation_stays_quarantined(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "recovery-observation.sqlite")
    fixture = _start_due_recovery(sessions, "cancel-recovery")
    with sessions() as session:
        same_recovery = acquire_broker_mutation_recovery(
            session,
            receipt_id=fixture.receipt_id,
            recovery_owner="reader-a",
            writer_generation=10,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=fixture.recovery_handle.recovery_token,
                lease_seconds=30,
            ),
        )
    assert same_recovery.outcome == "already_owned"
    with sessions() as session:
        busy = acquire_broker_mutation_recovery(
            session,
            receipt_id=fixture.receipt_id,
            recovery_owner="reader-b",
            writer_generation=11,
        )
    assert busy.outcome == "busy"

    wrong_observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id="cancel-recovery",
            checked_target_key="wrong-order",
            outcome="not_found",
            evidence_payload={"broker_status": "not_found"},
        )
    )
    with sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptValidationError,
            match="observation_identity_mismatch",
        ):
            record_broker_mutation_recovery_observation(
                session,
                handle=fixture.recovery_handle,
                observation=wrong_observation,
            )

    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id="cancel-recovery",
            checked_target_key="order/cancel-recovery",
            outcome="not_found",
            evidence_payload={"broker_status": "not_found"},
        )
    )
    with sessions() as session:
        observed = record_broker_mutation_recovery_observation(
            session,
            handle=fixture.recovery_handle,
            observation=observation,
            retry_seconds=30,
        )
    assert observed.state == "broker_io"
    assert observed.recovery.outcome == "not_found"
    with sessions() as session:
        released = release_broker_mutation_recovery(
            session,
            handle=fixture.recovery_handle,
        )
    assert released.state == "broker_io"
    with sessions() as session:
        assert list_due_broker_mutation_receipt_ids(session) == ()


def test_recovery_settlement_is_compatible_with_late_primary_ack(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "recovery-terminal.sqlite")
    fixture = _start_due_recovery(sessions, "cancel-recovery-terminal")
    _force_recovery_due(sessions, fixture.receipt_id)
    with sessions() as session:
        second_recovery = acquire_broker_mutation_recovery(
            session,
            receipt_id=fixture.receipt_id,
            recovery_owner="reader-b",
            writer_generation=11,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    assert second_recovery.receipt is not None
    second_handle = _recovery_handle(second_recovery.receipt)
    with sessions() as session:
        renewed = renew_broker_mutation_recovery(
            session,
            handle=second_handle,
            lease_seconds=60,
        )
    second_handle = _recovery_handle(renewed)

    reconciled = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="recovery",
            outcome="reconciled",
            broker_reference="broker-order-2",
            execution_id=None,
            evidence_payload={"broker_status": "accepted", "source": "lookup"},
        )
    )
    with sessions() as session:
        settled = settle_broker_mutation_recovery(
            session,
            handle=second_handle,
            settlement=reconciled,
        )
    assert settled.settlement.outcome == "reconciled"
    assert broker_mutation_runtime_result(settled) == "reconciled"

    late_ack = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference="broker-order-2",
            execution_id=None,
            evidence_payload={"broker_status": "accepted", "source": "late_response"},
        )
    )
    with sessions() as session:
        compatible = settle_broker_mutation_primary(
            session,
            handle=fixture.primary_handle,
            settlement=late_ack,
        )
    assert compatible.settlement.outcome == "reconciled"
    with sessions() as session:
        assert list_due_broker_mutation_receipt_ids(session) == ()
        current = get_broker_mutation_receipt(session, fixture.receipt_id)
    assert current is not None and current.state == "settled"
