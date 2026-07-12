from __future__ import annotations

import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass, replace
from threading import Event
from unittest.mock import patch

import pytest
from alembic import command
from sqlalchemy import event, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.trading.broker_mutation_receipts import (
    BrokerMutationLinkedSubmissionRecoveryAcquireResult,
    BrokerMutationLinkedSubmissionRecoveryHandle,
    BrokerMutationReceiptAcquireResult,
    BrokerMutationReceiptError,
    BrokerMutationReceiptValidationError,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlementRequest,
    acquire_linked_submission_recovery,
    build_broker_mutation_recovery_observation,
    build_broker_mutation_settlement,
    build_linked_submission_recovery_settlement,
    get_broker_mutation_receipt_history,
    record_linked_submission_recovery_observation,
    release_linked_submission_recovery,
    renew_linked_submission_recovery,
    settle_linked_submission_recovery,
)
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    full_state_values_from_event,
    load_latest_receipt_event,
)
from tests.execution.linked_submission_recovery_postgres_support import (
    RecoveryHarness,
    build_recovery_harness,
    enter_linked_io,
    force_linked_recovery_due,
)
from tests.execution.test_broker_mutation_linked_receipts_postgres import (
    LinkedSubmitFixture,
)


@pytest.fixture
def recovery_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[RecoveryHarness]:
    yield from build_recovery_harness(monkeypatch)


@dataclass(frozen=True, slots=True)
class _RecoveryContext:
    fixture: LinkedSubmitFixture
    acquired: BrokerMutationReceiptAcquireResult
    recovery: BrokerMutationLinkedSubmissionRecoveryAcquireResult

    @property
    def handle(self) -> BrokerMutationLinkedSubmissionRecoveryHandle:
        handle = self.recovery.handle
        assert handle is not None
        return handle


def _acquire_linked_recovery(
    harness: RecoveryHarness,
    *,
    token: uuid.UUID | None = None,
) -> _RecoveryContext:
    fixture, acquired = enter_linked_io(harness)
    recovery_token = token or uuid.uuid4()
    with harness.sessions() as session:
        premature = acquire_linked_submission_recovery(
            session,
            receipt_id=acquired.receipt.receipt_id,
            recovery_owner="reconciler-a",
            writer_generation=7,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=recovery_token,
                lease_seconds=30,
            ),
        )
    assert premature.outcome == "not_ready"
    force_linked_recovery_due(
        harness,
        fixture=fixture,
        receipt_id=acquired.receipt.receipt_id,
    )
    with harness.sessions() as session:
        recovery = acquire_linked_submission_recovery(
            session,
            receipt_id=acquired.receipt.receipt_id,
            recovery_owner="reconciler-a",
            writer_generation=7,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=recovery_token,
                lease_seconds=30,
            ),
        )
    assert recovery.outcome == "acquired"
    return _RecoveryContext(
        fixture=fixture,
        acquired=acquired,
        recovery=recovery,
    )


def _observation(fixture: LinkedSubmitFixture, outcome: str):
    return build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=fixture.claim_handle.client_order_id,
            checked_target_key=fixture.claim_handle.client_order_id,
            outcome=outcome,
            evidence_payload={"broker_read": outcome},
        )
    )


def _insert_execution(
    session: Session,
    *,
    fixture: LinkedSubmitFixture,
    execution_id: uuid.UUID,
    broker_order_id: str,
) -> None:
    session.execute(
        text(
            """
            INSERT INTO executions (
                id, trade_decision_id, alpaca_account_label,
                client_order_id, alpaca_order_id, status
            ) VALUES (
                :execution_id, :decision_id, 'paper',
                :client_order_id, :broker_order_id, 'accepted'
            )
            """
        ),
        {
            "execution_id": execution_id,
            "decision_id": fixture.decision_id,
            "client_order_id": fixture.claim_handle.client_order_id,
            "broker_order_id": broker_order_id,
        },
    )


def _recovery_settlement(
    context: _RecoveryContext,
    *,
    execution_id: uuid.UUID,
    broker_order_id: str,
):
    return build_linked_submission_recovery_settlement(
        submission_claim_handle=context.handle.submission_claim,
        broker_status="accepted",
        broker_reference=broker_order_id,
        execution_id=execution_id,
    )


def _assert_recovery_still_nonterminal(
    harness: RecoveryHarness,
    *,
    context: _RecoveryContext,
) -> None:
    with harness.engine.connect() as connection:
        claim = connection.execute(
            text(
                """
                SELECT state, recovery_token, recovery_fencing_epoch,
                       terminal_receipt_event_id
                  FROM trade_decision_submission_claims
                 WHERE trade_decision_id = :decision_id
                """
            ),
            {"decision_id": context.fixture.decision_id},
        ).one()
        latest = connection.execute(
            text(
                """
                SELECT state, event_type, recovery_token, recovery_epoch
                  FROM broker_mutation_receipt_events
                 WHERE receipt_id = :receipt_id
                 ORDER BY sequence_no DESC LIMIT 1
                """
            ),
            {"receipt_id": context.acquired.receipt.receipt_id},
        ).one()
        event_count = connection.execute(
            text(
                "SELECT count(*) FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :receipt_id"
            ),
            {"receipt_id": context.acquired.receipt.receipt_id},
        ).scalar_one()
        execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": context.fixture.decision_id},
        ).scalar_one()
    assert tuple(claim) == (
        "broker_io",
        context.handle.submission_claim.recovery_token,
        context.handle.submission_claim.recovery_fencing_epoch,
        None,
    )
    assert tuple(latest) == (
        "broker_io",
        "recovery_claimed",
        context.handle.receipt.recovery_token,
        context.handle.receipt.recovery_epoch,
    )
    assert event_count == 3
    assert execution_count == 0


@pytest.mark.parametrize("observation_outcome", ["not_found", "indeterminate"])
def test_paired_recovery_acquire_retry_renew_release_and_observe(
    recovery_harness: RecoveryHarness,
    observation_outcome: str,
) -> None:
    token = uuid.uuid4()
    context = _acquire_linked_recovery(recovery_harness, token=token)
    handle = context.handle
    assert handle.receipt.recovery_token == token
    assert handle.submission_claim.recovery_token == token
    assert handle.receipt.recovery_epoch == 1
    assert handle.submission_claim.recovery_fencing_epoch == 1
    assert handle.receipt.recovery_owner == handle.submission_claim.recovery_owner
    assert (
        handle.receipt.recovery_lease_expires_at
        == handle.submission_claim.lease_expires_at
    )

    with recovery_harness.sessions() as session:
        repeated = acquire_linked_submission_recovery(
            session,
            receipt_id=context.acquired.receipt.receipt_id,
            recovery_owner="reconciler-a",
            writer_generation=7,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=token,
                lease_seconds=30,
            ),
        )
    assert repeated.outcome == "already_owned"
    assert repeated.handle == handle

    with recovery_harness.sessions() as session:
        renewed = renew_linked_submission_recovery(
            session,
            handle=handle,
            lease_seconds=60,
        )
    assert renewed.handle.receipt.recovery_token == token
    assert renewed.handle.receipt.recovery_epoch == handle.receipt.recovery_epoch
    assert (
        renewed.handle.receipt.recovery_lease_expires_at
        == renewed.handle.submission_claim.lease_expires_at
    )
    assert (
        renewed.handle.receipt.recovery_lease_expires_at
        > handle.receipt.recovery_lease_expires_at
    )
    with recovery_harness.sessions() as session:
        repeated_renewal = renew_linked_submission_recovery(
            session,
            handle=handle,
            lease_seconds=60,
        )
        renewal_history = get_broker_mutation_receipt_history(
            session,
            context.acquired.receipt.receipt_id,
        )
    assert repeated_renewal == renewed
    assert [item.event_type for item in renewal_history].count("recovery_renewed") == 1
    with recovery_harness.sessions() as session:
        released = release_linked_submission_recovery(
            session,
            handle=renewed.handle,
        )
    assert released.receipt.recovery_handle is not None
    assert released.submission_claim.recovery_handle is not None
    assert (
        released.receipt.recovery_handle.recovery_lease_expires_at
        == released.submission_claim.recovery_handle.lease_expires_at
    )
    assert released.receipt.lifecycle.event_type == "recovery_released"
    with recovery_harness.sessions() as session:
        repeated_release = release_linked_submission_recovery(
            session,
            handle=renewed.handle,
        )
    assert repeated_release == released

    with recovery_harness.sessions() as session:
        observed_recovery = acquire_linked_submission_recovery(
            session,
            receipt_id=context.acquired.receipt.receipt_id,
            recovery_owner="reconciler-b",
            writer_generation=8,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    assert observed_recovery.outcome == "acquired"
    observed_context = _RecoveryContext(
        fixture=context.fixture,
        acquired=context.acquired,
        recovery=observed_recovery,
    )
    observation = _observation(observed_context.fixture, observation_outcome)
    with recovery_harness.sessions() as session:
        observed = record_linked_submission_recovery_observation(
            session,
            handle=observed_context.handle,
            observation=observation,
            retry_seconds=60,
        )
    assert observed.receipt.state == "broker_io"
    assert observed.submission_claim.state == "broker_io"
    assert observed.receipt.recovery_handle is not None
    assert observed.submission_claim.recovery_handle is not None
    assert observed.receipt.recovery.outcome == observation_outcome
    assert observed.submission_claim.recovery_outcome == observation_outcome
    assert observed.receipt.recovery.evidence_json == observation.evidence_json
    assert observed.submission_claim.recovery_evidence == observation.evidence_json
    assert (
        observed.receipt.recovery_handle.recovery_lease_expires_at
        == observed.submission_claim.recovery_handle.lease_expires_at
    )
    assert (
        observed.receipt.lifecycle.recovery_after
        == observed.submission_claim.recovery_after
    )
    with recovery_harness.sessions() as session:
        repeated_observation = record_linked_submission_recovery_observation(
            session,
            handle=observed_context.handle,
            observation=observation,
            retry_seconds=60,
        )
        history = get_broker_mutation_receipt_history(
            session,
            context.acquired.receipt.receipt_id,
        )
    assert repeated_observation == observed
    assert [item.event_type for item in history].count("recovery_observed") == 1


def test_paired_recovery_acquisition_race_has_one_fence_pair(
    recovery_harness: RecoveryHarness,
) -> None:
    fixture, acquired = enter_linked_io(recovery_harness)
    force_linked_recovery_due(
        recovery_harness,
        fixture=fixture,
        receipt_id=acquired.receipt.receipt_id,
    )

    def acquire(token: uuid.UUID):
        with recovery_harness.sessions() as session:
            return acquire_linked_submission_recovery(
                session,
                receipt_id=acquired.receipt.receipt_id,
                recovery_owner=f"reconciler-{token.hex[:8]}",
                writer_generation=7,
                options=BrokerMutationRecoveryAcquireOptions(
                    recovery_token=token,
                    lease_seconds=30,
                ),
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = tuple(executor.map(acquire, (uuid.uuid4(), uuid.uuid4())))
    assert {result.outcome for result in results} == {"acquired", "busy"}
    winner = next(result for result in results if result.outcome == "acquired")
    loser = next(result for result in results if result.outcome == "busy")
    assert winner.handle is not None
    assert loser.receipt is not None
    assert loser.submission_claim is not None
    assert loser.receipt.recovery_handle == winner.handle.receipt
    assert loser.submission_claim.recovery_handle == winner.handle.submission_claim
    with recovery_harness.sessions() as session:
        history = get_broker_mutation_receipt_history(
            session,
            acquired.receipt.receipt_id,
        )
    assert [item.event_type for item in history] == [
        "primary_claimed",
        "broker_io_started",
        "recovery_claimed",
    ]


def test_recovery_reconciled_terminal_commits_exactly_once(
    recovery_harness: RecoveryHarness,
) -> None:
    context = _acquire_linked_recovery(recovery_harness)
    execution_id = uuid.uuid4()
    broker_order_id = "recovered-order"
    settlement = _recovery_settlement(
        context,
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )
    with recovery_harness.sessions() as session:
        _insert_execution(
            session,
            fixture=context.fixture,
            execution_id=execution_id,
            broker_order_id=broker_order_id,
        )
        terminal = settle_linked_submission_recovery(
            session,
            handle=context.handle,
            settlement=settlement,
        )
    assert terminal.runtime_result == "reconciled"
    assert terminal.receipt.settlement.source == "recovery"
    assert terminal.receipt.settlement.outcome == "reconciled"
    assert terminal.receipt.settlement.evidence_json == settlement.evidence_json
    assert terminal.submission_claim.state == "submitted"
    assert terminal.submission_claim.execution_id == execution_id
    assert terminal.submission_claim.broker_order_id == broker_order_id
    assert terminal.submission_claim.recovery_outcome == "found"
    assert (
        terminal.submission_claim.recovery_observation_epoch
        == context.handle.submission_claim.recovery_fencing_epoch
    )
    assert terminal.submission_claim.recovery_evidence == settlement.evidence_json
    assert (
        terminal.submission_claim.completed_at == terminal.receipt.settlement.settled_at
    )
    assert terminal.receipt.recovery_handle is not None
    assert terminal.submission_claim.recovery_handle is not None
    assert (
        terminal.receipt.recovery_handle.recovery_lease_expires_at
        == terminal.submission_claim.recovery_handle.lease_expires_at
    )

    with recovery_harness.sessions() as session:
        repeated = settle_linked_submission_recovery(
            session,
            handle=context.handle,
            settlement=settlement,
        )
        history = get_broker_mutation_receipt_history(
            session,
            context.acquired.receipt.receipt_id,
        )
    assert repeated == terminal
    assert [item.event_type for item in history] == [
        "primary_claimed",
        "broker_io_started",
        "recovery_claimed",
        "settled",
    ]
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


def test_recovery_acknowledged_and_rejected_terminals_fail_closed(
    recovery_harness: RecoveryHarness,
) -> None:
    context = _acquire_linked_recovery(recovery_harness)
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="recovery_cannot_acknowledge_new_broker_io",
    ):
        build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="recovery",
                outcome="acknowledged",
                broker_reference="new-order",
                execution_id=uuid.uuid4(),
                evidence_payload={"case": "unsafe_acknowledgement"},
            )
        )
    rejected = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="recovery",
            outcome="rejected",
            broker_reference=None,
            execution_id=None,
            evidence_payload={"case": "unsafe_rejection"},
        )
    )
    with recovery_harness.sessions() as session:
        with pytest.raises(BrokerMutationReceiptValidationError):
            settle_linked_submission_recovery(
                session,
                handle=context.handle,
                settlement=rejected,
            )
    _assert_recovery_still_nonterminal(recovery_harness, context=context)


def test_stale_paired_recovery_handles_cannot_mutate_either_half(
    recovery_harness: RecoveryHarness,
) -> None:
    context = _acquire_linked_recovery(recovery_harness)
    stale_handles = (
        replace(
            context.handle,
            receipt=replace(context.handle.receipt, recovery_token=uuid.uuid4()),
        ),
        replace(
            context.handle,
            submission_claim=replace(
                context.handle.submission_claim,
                recovery_token=uuid.uuid4(),
            ),
        ),
        replace(
            context.handle,
            submission_claim=replace(
                context.handle.submission_claim,
                recovery_fencing_epoch=(
                    context.handle.submission_claim.recovery_fencing_epoch + 1
                ),
            ),
        ),
    )
    for stale_handle in stale_handles:
        with recovery_harness.sessions() as session:
            with pytest.raises(BrokerMutationReceiptError):
                renew_linked_submission_recovery(
                    session,
                    handle=stale_handle,
                    lease_seconds=60,
                )
            assert not session.in_transaction()
    _assert_recovery_still_nonterminal(recovery_harness, context=context)


@pytest.mark.parametrize("failure_point", ["append", "commit"])
def test_recovery_terminal_failure_rolls_back_claim_receipt_and_execution(
    recovery_harness: RecoveryHarness,
    failure_point: str,
) -> None:
    context = _acquire_linked_recovery(recovery_harness)
    execution_id = uuid.uuid4()
    broker_order_id = f"rollback-{failure_point}"
    settlement = _recovery_settlement(
        context,
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )
    patch_target = "app.trading.broker_mutation_receipts.linked_recovery." + (
        "append_full_state_event" if failure_point == "append" else "commit_or_rollback"
    )
    with recovery_harness.sessions() as session:
        _insert_execution(
            session,
            fixture=context.fixture,
            execution_id=execution_id,
            broker_order_id=broker_order_id,
        )
        with patch(patch_target, side_effect=RuntimeError(f"injected {failure_point}")):
            with pytest.raises(RuntimeError, match=f"injected {failure_point}"):
                settle_linked_submission_recovery(
                    session,
                    handle=context.handle,
                    settlement=settlement,
                )
        assert not session.in_transaction()
    _assert_recovery_still_nonterminal(recovery_harness, context=context)


def test_0062_deferred_guards_reject_each_recovery_lease_half(
    recovery_harness: RecoveryHarness,
) -> None:
    receipt_fixture, receipt_acquired = enter_linked_io(recovery_harness)
    force_linked_recovery_due(
        recovery_harness,
        fixture=receipt_fixture,
        receipt_id=receipt_acquired.receipt.receipt_id,
    )
    with recovery_harness.sessions() as session:
        current = load_latest_receipt_event(
            session,
            receipt_acquired.receipt.receipt_id,
        )
        assert current is not None
        now = session.execute(text("SELECT clock_timestamp()")).scalar_one()
        values = full_state_values_from_event(current)
        values.update(
            sequence_no=current.sequence_no + 1,
            event_type="recovery_claimed",
            event_writer_generation=7,
            recovery_token=uuid.uuid4(),
            recovery_epoch=current.recovery_epoch + 1,
            recovery_owner="raw-receipt-half",
            recovery_writer_generation=7,
            recovery_lease_started_at=now,
            recovery_lease_expires_at=session.execute(
                text("SELECT clock_timestamp() + interval '30 seconds'")
            ).scalar_one(),
        )
        append_full_state_event(
            session,
            receipt_id=receipt_acquired.receipt.receipt_id,
            values=values,
        )
        with pytest.raises(
            DBAPIError,
            match="linked nonterminal recovery state is asymmetric",
        ):
            session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        session.rollback()

    claim_fixture = receipt_fixture
    with recovery_harness.sessions() as session:
        token = uuid.uuid4()
        session.execute(
            text(
                """
                UPDATE trade_decision_submission_claims
                   SET recovery_token = :token,
                       recovery_fencing_epoch = recovery_fencing_epoch + 1,
                       recovery_owner = 'raw-claim-half',
                       recovery_lease_started_at = clock_timestamp(),
                       recovery_lease_expires_at =
                           clock_timestamp() + interval '30 seconds',
                       updated_at = clock_timestamp()
                 WHERE trade_decision_id = :decision_id
                """
            ),
            {"token": token, "decision_id": claim_fixture.decision_id},
        )
        with pytest.raises(
            DBAPIError,
            match="linked nonterminal recovery state is asymmetric",
        ):
            session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        session.rollback()


@pytest.mark.parametrize("outcome", ["acknowledged", "rejected"])
def test_0062_database_rejects_nonreconciled_recovery_terminal(
    recovery_harness: RecoveryHarness,
    outcome: str,
) -> None:
    context = _acquire_linked_recovery(recovery_harness)
    execution_id = uuid.uuid4()
    broker_order_id = "raw-nonreconciled"
    settlement = _recovery_settlement(
        context,
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )
    with recovery_harness.sessions() as session:
        if outcome == "acknowledged":
            _insert_execution(
                session,
                fixture=context.fixture,
                execution_id=execution_id,
                broker_order_id=broker_order_id,
            )
        current = load_latest_receipt_event(
            session,
            context.acquired.receipt.receipt_id,
        )
        assert current is not None
        values = full_state_values_from_event(current)
        values.update(
            sequence_no=current.sequence_no + 1,
            event_type="settled",
            state="settled",
            event_writer_generation=context.handle.receipt.recovery_writer_generation,
            settlement_source="recovery",
            settlement_outcome=outcome,
            broker_reference=(broker_order_id if outcome == "acknowledged" else None),
            execution_id=(execution_id if outcome == "acknowledged" else None),
            settlement_evidence_json=settlement.evidence_json,
            settlement_evidence_sha256=settlement.evidence_sha256,
            settled_at=current.recorded_at,
        )
        with pytest.raises(DBAPIError):
            append_full_state_event(
                session,
                receipt_id=context.acquired.receipt.receipt_id,
                values=values,
            )
        session.rollback()
    _assert_recovery_still_nonterminal(recovery_harness, context=context)


def test_0062_database_rejects_null_found_observation(
    recovery_harness: RecoveryHarness,
) -> None:
    context = _acquire_linked_recovery(recovery_harness)
    execution_id = uuid.uuid4()
    broker_order_id = "raw-null-found"
    invalid = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="recovery",
            outcome="reconciled",
            broker_reference=broker_order_id,
            execution_id=execution_id,
            evidence_payload={
                "schema_version": ("torghut.linked-submission-recovery-terminal.v1"),
                "decision_id": str(context.fixture.decision_id),
                "account_label": context.fixture.claim_handle.account_label,
                "client_order_id": context.fixture.claim_handle.client_order_id,
                "checked_client_order_id": (
                    context.fixture.claim_handle.client_order_id
                ),
                "checked_target_key": context.fixture.claim_handle.client_order_id,
                "observation_outcome": None,
                "broker_status": "accepted",
                "rejection_code": None,
            },
        )
    )
    with recovery_harness.sessions() as session:
        _insert_execution(
            session,
            fixture=context.fixture,
            execution_id=execution_id,
            broker_order_id=broker_order_id,
        )
        current = load_latest_receipt_event(
            session,
            context.acquired.receipt.receipt_id,
        )
        assert current is not None
        now = session.execute(text("SELECT clock_timestamp()")).scalar_one()
        values = full_state_values_from_event(current)
        values.update(
            sequence_no=current.sequence_no + 1,
            event_type="settled",
            state="settled",
            event_writer_generation=context.handle.receipt.recovery_writer_generation,
            recovery_lease_expires_at=now,
            settlement_source=invalid.source,
            settlement_outcome=invalid.outcome,
            broker_reference=invalid.broker_reference,
            execution_id=invalid.execution_id,
            settlement_evidence_json=invalid.evidence_json,
            settlement_evidence_sha256=invalid.evidence_sha256,
            settled_at=now,
        )
        with pytest.raises(
            DBAPIError,
            match="linked recovery terminal evidence envelope mismatch",
        ):
            append_full_state_event(
                session,
                receipt_id=context.acquired.receipt.receipt_id,
                values=values,
            )
        session.rollback()


def test_exact_recovery_terminal_race_converges_to_one_event(
    recovery_harness: RecoveryHarness,
) -> None:
    context = _acquire_linked_recovery(recovery_harness)
    execution_id = uuid.uuid4()
    broker_order_id = "recovery-race"
    settlement = _recovery_settlement(
        context,
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )
    terminal_inserted = Event()
    release_winner = Event()

    def pause_winner_after_terminal_insert(
        _connection: Connection,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if (
            "INSERT INTO broker_mutation_receipt_events" in statement
            and not terminal_inserted.is_set()
        ):
            terminal_inserted.set()
            assert release_winner.wait(timeout=10)

    def winner():
        with recovery_harness.sessions() as session:
            _insert_execution(
                session,
                fixture=context.fixture,
                execution_id=execution_id,
                broker_order_id=broker_order_id,
            )
            return settle_linked_submission_recovery(
                session,
                handle=context.handle,
                settlement=settlement,
            )

    def retry():
        with recovery_harness.sessions() as session:
            return settle_linked_submission_recovery(
                session,
                handle=context.handle,
                settlement=settlement,
            )

    event.listen(
        recovery_harness.engine,
        "after_cursor_execute",
        pause_winner_after_terminal_insert,
    )
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            winner_future = executor.submit(winner)
            assert terminal_inserted.wait(timeout=10)
            retry_future = executor.submit(retry)
            with pytest.raises(FutureTimeoutError):
                retry_future.result(timeout=0.2)
            release_winner.set()
            winner_result = winner_future.result(timeout=10)
            retry_result = retry_future.result(timeout=10)
    finally:
        release_winner.set()
        event.remove(
            recovery_harness.engine,
            "after_cursor_execute",
            pause_winner_after_terminal_insert,
        )
    assert winner_result == retry_result
    with recovery_harness.sessions() as session:
        history = get_broker_mutation_receipt_history(
            session,
            context.acquired.receipt.receipt_id,
        )
    assert [item.event_type for item in history] == [
        "primary_claimed",
        "broker_io_started",
        "recovery_claimed",
        "settled",
    ]
