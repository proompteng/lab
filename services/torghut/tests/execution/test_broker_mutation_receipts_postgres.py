from __future__ import annotations

import hashlib
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal
from threading import Barrier

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import BrokerMutationReceiptEvent
from app.trading.broker_mutation_receipts.canonicalization import (
    build_broker_mutation_intent,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationIoStartResult,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptAcquireResult,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptSnapshot,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryAcquireResult,
    BrokerMutationRecoveryHandle,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlementRequest,
    acquire_broker_mutation_receipt,
    acquire_broker_mutation_recovery,
    build_broker_mutation_settlement,
    build_broker_mutation_recovery_observation,
    get_broker_mutation_receipt_history,
    list_due_broker_mutation_receipt_ids,
    mark_broker_mutation_io_started,
    record_broker_mutation_recovery_observation,
    release_broker_mutation_recovery,
    settle_broker_mutation_primary,
    settle_broker_mutation_recovery,
)
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    commit_or_rollback,
    database_now,
    insert_receipt_header_if_absent,
    load_receipt_event_models,
    load_receipt_event_history,
)
from app.trading.broker_mutation_receipts.types import (
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
)
from app.trading.decision_submission_claims import (
    DecisionSubmissionClaimHandle,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    assert_rejected,
    create_parent_tables,
    insert_claimed,
    insert_decision,
)


def _initial_event_values(
    *,
    now: datetime,
    token: uuid.UUID,
    submission_claim_handle: DecisionSubmissionClaimHandle | None = None,
) -> dict[str, object]:
    claim = submission_claim_handle
    return {
        "sequence_no": 1,
        "event_type": "primary_claimed",
        "state": "claimed",
        "event_writer_generation": 1,
        "primary_token": token,
        "primary_epoch": 1,
        "primary_owner": "writer-a",
        "primary_writer_generation": 1,
        "submission_claim_token": claim.claim_token if claim is not None else None,
        "submission_claim_fencing_epoch": (
            claim.fencing_epoch if claim is not None else None
        ),
        "submission_claim_owner": claim.claim_owner if claim is not None else None,
        "primary_claimed_at": now,
        "primary_lease_expires_at": now + timedelta(seconds=30),
        "released_at": None,
        "release_reason": None,
        "broker_io_started_at": None,
        "recovery_after": None,
        "recovery_token": None,
        "recovery_epoch": 0,
        "recovery_owner": None,
        "recovery_writer_generation": None,
        "recovery_lease_started_at": None,
        "recovery_lease_expires_at": None,
        "recovery_checked_at": None,
        "recovery_observation_epoch": None,
        "recovery_outcome": None,
        "settlement_source": None,
        "settlement_outcome": None,
        "broker_reference": None,
        "execution_id": None,
        "recovery_evidence_json": None,
        "recovery_evidence_sha256": None,
        "settlement_evidence_json": None,
        "settlement_evidence_sha256": None,
        "settled_at": None,
    }


def _copied_event_values(event: BrokerMutationReceiptEvent) -> dict[str, object]:
    return {
        column.name: getattr(event, column.name)
        for column in BrokerMutationReceiptEvent.__table__.columns
        if column.name not in {"id", "receipt_id", "recorded_at"}
    }


def _force_recovery_due(schema_engine: Engine, receipt_id: uuid.UUID) -> None:
    with schema_engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events "
                "DISABLE TRIGGER trg_guard_bm_receipt_event"
            )
        )
        connection.execute(
            text(
                """
                UPDATE broker_mutation_receipt_events
                   SET recovery_after = clock_timestamp() - interval '1 minute',
                       recovery_lease_started_at = CASE
                           WHEN recovery_epoch > 0
                           THEN clock_timestamp() - interval '2 minutes'
                           ELSE NULL
                       END,
                       recovery_lease_expires_at = CASE
                           WHEN recovery_epoch > 0
                           THEN clock_timestamp() - interval '1 minute'
                           ELSE NULL
                       END
                 WHERE id = (
                     SELECT id FROM broker_mutation_receipt_events
                      WHERE receipt_id = :receipt_id
                      ORDER BY sequence_no DESC
                      LIMIT 1
                 )
                """
            ),
            {"receipt_id": receipt_id},
        )
        connection.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events "
                "ENABLE TRIGGER trg_guard_bm_receipt_event"
            )
        )


def _race_primary_acquisition(
    sessions: sessionmaker[Session],
    intent: BrokerMutationIntent,
    submission_claim_handle: DecisionSubmissionClaimHandle | None = None,
) -> BrokerMutationReceiptAcquireResult:
    barrier = Barrier(2)
    tokens = (uuid.uuid4(), uuid.uuid4())

    def acquire(index: int) -> BrokerMutationReceiptAcquireResult:
        with sessions() as session:
            barrier.wait(timeout=10)
            return acquire_broker_mutation_receipt(
                session,
                intent=intent,
                primary_owner=(
                    submission_claim_handle.claim_owner
                    if submission_claim_handle is not None
                    else f"writer-{index}"
                ),
                writer_generation=index,
                options=BrokerMutationReceiptAcquireOptions(
                    primary_token=tokens[index - 1],
                    lease_seconds=30,
                    submission_claim_handle=submission_claim_handle,
                ),
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(acquire, (1, 2)))
    assert sorted(result.outcome for result in results) == ["acquired", "busy"]
    assert len({result.receipt.receipt_id for result in results}) == 1
    return next(result for result in results if result.outcome == "acquired")


def _race_io_start(
    sessions: sessionmaker[Session],
    handle: BrokerMutationReceiptHandle,
    submission_claim_handle: DecisionSubmissionClaimHandle | None = None,
) -> BrokerMutationReceiptSnapshot:
    barrier = Barrier(2)

    def start_io(_: int) -> BrokerMutationIoStartResult:
        with sessions() as session:
            barrier.wait(timeout=10)
            return mark_broker_mutation_io_started(
                session,
                handle=handle,
                submission_claim_handle=submission_claim_handle,
                recovery_seconds=30,
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(start_io, (1, 2)))
    assert sorted(result.outcome for result in results) == [
        "already_started",
        "authorized",
    ]
    authorized = next(result for result in results if result.authorized)
    assert authorized.permit is not None
    assert sum(result.permit is not None for result in results) == 1
    return authorized.receipt


def _race_recovery_acquisition(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> BrokerMutationRecoveryHandle:
    barrier = Barrier(2)
    tokens = (uuid.uuid4(), uuid.uuid4())

    def acquire(index: int) -> BrokerMutationRecoveryAcquireResult:
        with sessions() as session:
            barrier.wait(timeout=10)
            return acquire_broker_mutation_recovery(
                session,
                receipt_id=receipt_id,
                recovery_owner=f"reader-{index}",
                writer_generation=index + 10,
                options=BrokerMutationRecoveryAcquireOptions(
                    recovery_token=tokens[index - 1],
                    lease_seconds=30,
                ),
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(acquire, (1, 2)))
    assert sorted(result.outcome for result in results) == ["acquired", "busy"]
    winner = next(result for result in results if result.outcome == "acquired")
    assert winner.receipt is not None
    handle = winner.receipt.recovery_handle
    assert handle is not None
    return handle


def _advance_recovery_epoch(
    sessions: sessionmaker[Session],
    schema_engine: Engine,
    receipt_id: uuid.UUID,
    intent: BrokerMutationIntent,
    handle: BrokerMutationRecoveryHandle,
) -> BrokerMutationRecoveryHandle:
    _assert_database_recovery_envelope_guards(
        sessions,
        receipt_id,
        intent,
        handle,
    )
    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=intent.client_request_id,
            checked_target_key=intent.target.key,
            outcome="not_found",
            evidence_payload={"broker_status": "not_found"},
        )
    )
    with sessions() as session:
        observed = record_broker_mutation_recovery_observation(
            session,
            handle=handle,
            observation=observation,
            retry_seconds=30,
        )
    assert observed.state == "broker_io"
    assert observed.recovery.outcome == "not_found"
    with sessions() as session:
        released = release_broker_mutation_recovery(session, handle=handle)
    assert released.state == "broker_io"
    _force_recovery_due(schema_engine, receipt_id)
    return _race_recovery_acquisition(sessions, receipt_id)


def _assert_database_recovery_envelope_guards(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
    intent: BrokerMutationIntent,
    handle: BrokerMutationRecoveryHandle,
) -> None:
    invalid_envelopes = (
        ("indeterminate", {"case": "outcome_mismatch"}),
        ("not_found", {"token": "forbidden"}),
    )
    for envelope_outcome, evidence in invalid_envelopes:
        with sessions() as session:
            event = load_receipt_event_models(session, receipt_id)[-1]
            values = _copied_event_values(event)
            now = database_now(session)
            evidence_document = {
                "schema_version": "torghut.broker-mutation-recovery-evidence.v1",
                "checked_client_request_id": intent.client_request_id,
                "checked_target_key": intent.target.key,
                "outcome": envelope_outcome,
                "observation": evidence,
            }
            evidence_json = json.dumps(
                evidence_document,
                sort_keys=True,
                separators=(",", ":"),
            )
            evidence_sha256 = hashlib.sha256(evidence_json.encode()).hexdigest()
            values.update(
                sequence_no=event.sequence_no + 1,
                event_type="recovery_observed",
                event_writer_generation=handle.recovery_writer_generation,
                recovery_after=now + timedelta(seconds=30),
                recovery_checked_at=now,
                recovery_observation_epoch=handle.recovery_epoch,
                recovery_outcome="not_found",
                recovery_evidence_json=evidence_json,
                recovery_evidence_sha256=evidence_sha256,
            )
            with pytest.raises(DBAPIError):
                append_full_state_event(session, receipt_id=receipt_id, values=values)
            session.rollback()


def _race_compatible_settlement(
    sessions: sessionmaker[Session],
    primary_handle: BrokerMutationReceiptHandle,
    recovery_handle: BrokerMutationRecoveryHandle,
) -> tuple[BrokerMutationReceiptSnapshot, BrokerMutationReceiptSnapshot]:
    primary_terminal = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference="broker-order-race",
            execution_id=None,
            evidence_payload={"source": "late_primary_response"},
        )
    )
    recovery_terminal = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="recovery",
            outcome="reconciled",
            broker_reference="broker-order-race",
            execution_id=None,
            evidence_payload={"source": "broker_lookup"},
        )
    )
    barrier = Barrier(2)

    def settle_primary() -> BrokerMutationReceiptSnapshot:
        with sessions() as session:
            barrier.wait(timeout=10)
            return settle_broker_mutation_primary(
                session,
                handle=primary_handle,
                settlement=primary_terminal,
            )

    def settle_recovery() -> BrokerMutationReceiptSnapshot:
        with sessions() as session:
            barrier.wait(timeout=10)
            return settle_broker_mutation_recovery(
                session,
                handle=recovery_handle,
                settlement=recovery_terminal,
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        primary_future = executor.submit(settle_primary)
        recovery_future = executor.submit(settle_recovery)
        return primary_future.result(), recovery_future.result()


def _persist_low_level_receipt(
    sessions: sessionmaker[Session],
    intent: BrokerMutationIntent,
    *,
    primary_token: uuid.UUID | None = None,
    submission_claim_handle: DecisionSubmissionClaimHandle | None = None,
) -> uuid.UUID:
    receipt_id = uuid.uuid4()
    with sessions() as session:
        assert (
            insert_receipt_header_if_absent(
                session,
                receipt_id=receipt_id,
                intent=intent,
                creator_owner="writer-a",
                origin_writer_generation=1,
            )
            == receipt_id
        )
        now = database_now(session)
        append_full_state_event(
            session,
            receipt_id=receipt_id,
            values=_initial_event_values(
                now=now,
                token=primary_token or uuid.uuid4(),
                submission_claim_handle=submission_claim_handle,
            ),
        )
        commit_or_rollback(session)
    return receipt_id


def _assert_submit_claim_identity_is_unique(
    sessions: sessionmaker[Session],
    intent: BrokerMutationIntent,
) -> None:
    assert intent.submission_claim_id is not None
    conflicting = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route=intent.broker_route,
            account_label=intent.account_label,
            endpoint_fingerprint="b" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="workflow-conflict",
            client_request_id=intent.client_request_id,
            target=BrokerMutationTarget(
                kind="order",
                key=intent.client_request_id,
            ),
            request_payload={"symbol": "AAPL", "qty": Decimal("1")},
            submission_claim_id=intent.submission_claim_id,
        )
    )
    with sessions() as session:
        inserted = insert_receipt_header_if_absent(
            session,
            receipt_id=uuid.uuid4(),
            intent=conflicting,
            creator_owner="writer-a",
            origin_writer_generation=2,
        )
        assert inserted is None
        session.rollback()


def _assert_raw_submit_header_guards(
    sessions: sessionmaker[Session],
    intent: BrokerMutationIntent,
) -> None:
    assert intent.submission_claim_id is not None
    invalid_requests = (
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label=intent.account_label,
            endpoint_fingerprint="c" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="wrong-client",
            client_request_id="d" * 64,
            target=BrokerMutationTarget(kind="order", key="d" * 64),
            request_payload={"symbol": "AAPL", "qty": Decimal("1")},
            submission_claim_id=intent.submission_claim_id,
        ),
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label=intent.account_label,
            endpoint_fingerprint="d" * 64,
            operation="replace_order",
            risk_class="risk_neutral",
            purpose="repricing",
            workflow_id="replace-disabled",
            client_request_id=intent.client_request_id,
            target=BrokerMutationTarget(kind="order", key=intent.client_request_id),
            request_payload={"order_id": "broker-order-1", "limit_price": "100"},
            submission_claim_id=intent.submission_claim_id,
        ),
    )
    for request in invalid_requests:
        invalid_intent = build_broker_mutation_intent(request)
        with sessions() as session:
            with pytest.raises(DBAPIError):
                insert_receipt_header_if_absent(
                    session,
                    receipt_id=uuid.uuid4(),
                    intent=invalid_intent,
                    creator_owner="writer-invalid",
                    origin_writer_generation=2,
                )
            session.rollback()

    document = json.loads(intent.canonical_intent_json)
    document["endpoint_fingerprint"] = "e" * 64
    document["request"]["api_key"] = "forbidden"
    canonical_json = json.dumps(document, sort_keys=True, separators=(",", ":"))
    secret_intent = replace(
        intent,
        endpoint_fingerprint="e" * 64,
        canonical_intent_json=canonical_json,
        canonical_intent_sha256=hashlib.sha256(canonical_json.encode()).hexdigest(),
    )
    with sessions() as session:
        with pytest.raises(DBAPIError, match="secret-bearing key forbidden"):
            insert_receipt_header_if_absent(
                session,
                receipt_id=uuid.uuid4(),
                intent=secret_intent,
                creator_owner="writer-a",
                origin_writer_generation=3,
            )
        session.rollback()


def _assert_linked_terminal_database_guard(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> None:
    settlement = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="preflight",
            outcome="already_satisfied",
            broker_reference="broker-existing-order",
            execution_id=None,
            evidence_payload={"case": "linked_terminal_must_wait_for_coordinator"},
        )
    )
    with sessions() as session:
        event = load_receipt_event_models(session, receipt_id)[-1]
        values = _copied_event_values(event)
        values.update(
            sequence_no=event.sequence_no + 1,
            event_type="settled",
            state="settled",
            settlement_source=settlement.source,
            settlement_outcome=settlement.outcome,
            broker_reference=settlement.broker_reference,
            settlement_evidence_json=settlement.evidence_json,
            settlement_evidence_sha256=settlement.evidence_sha256,
            settled_at=database_now(session),
        )
        with pytest.raises(DBAPIError, match="atomic coordinator"):
            append_full_state_event(session, receipt_id=receipt_id, values=values)
        session.rollback()


def _append_low_level_broker_io(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> None:
    with sessions() as session:
        latest_id = session.execute(
            text(
                "SELECT id FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :id ORDER BY sequence_no DESC LIMIT 1"
            ),
            {"id": receipt_id},
        ).scalar_one()
        event = session.get(BrokerMutationReceiptEvent, latest_id)
        assert event is not None
        values = _copied_event_values(event)
        now = database_now(session)
        values.update(
            sequence_no=2,
            event_type="broker_io_started",
            state="broker_io",
            broker_io_started_at=now,
            recovery_after=now + timedelta(seconds=120),
        )
        append_full_state_event(session, receipt_id=receipt_id, values=values)
        commit_or_rollback(session)


def _assert_database_terminal_guards(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> None:
    invalid_terminals = (
        ("recovery", "acknowledged", "broker-order-invalid", "acknowledged", {}),
        ("primary", "acknowledged", None, "acknowledged", {}),
        ("recovery", "reconciled", None, "reconciled", {}),
        ("primary", "rejected", None, "rejected", {"api_key": "forbidden"}),
        ("primary", "rejected", None, "already_satisfied", {}),
    )
    for (
        source,
        outcome,
        broker_reference,
        envelope_outcome,
        evidence,
    ) in invalid_terminals:
        with sessions() as session:
            latest_id = session.execute(
                text(
                    "SELECT id FROM broker_mutation_receipt_events "
                    "WHERE receipt_id = :id ORDER BY sequence_no DESC LIMIT 1"
                ),
                {"id": receipt_id},
            ).scalar_one()
            event = session.get(BrokerMutationReceiptEvent, latest_id)
            assert event is not None
            values = _copied_event_values(event)
            evidence_document = {
                "schema_version": "torghut.broker-mutation-settlement-evidence.v1",
                "source": source,
                "outcome": envelope_outcome,
                "broker_reference": broker_reference,
                "execution_id": None,
                "evidence": {"case": "database_terminal_guard", **evidence},
            }
            evidence_json = json.dumps(
                evidence_document,
                sort_keys=True,
                separators=(",", ":"),
            )
            evidence_sha256 = hashlib.sha256(evidence_json.encode()).hexdigest()
            values.update(
                sequence_no=event.sequence_no + 1,
                event_type="settled",
                state="settled",
                settlement_source=source,
                settlement_outcome=outcome,
                broker_reference=broker_reference,
                settlement_evidence_json=evidence_json,
                settlement_evidence_sha256=evidence_sha256,
                settled_at=database_now(session),
            )
            with pytest.raises(DBAPIError):
                append_full_state_event(
                    session,
                    receipt_id=receipt_id,
                    values=values,
                )
                session.commit()
            session.rollback()


def _race_incompatible_low_level_settlement(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
) -> list[str]:
    barrier = Barrier(2)

    def settle(outcome: str) -> str:
        with sessions() as session:
            latest_id = session.execute(
                text(
                    "SELECT id FROM broker_mutation_receipt_events "
                    "WHERE receipt_id = :id ORDER BY sequence_no DESC LIMIT 1"
                ),
                {"id": receipt_id},
            ).scalar_one()
            event = session.get(BrokerMutationReceiptEvent, latest_id)
            assert event is not None
            values = _copied_event_values(event)
            settlement = build_broker_mutation_settlement(
                BrokerMutationSettlementRequest(
                    source="primary",
                    outcome=outcome,
                    broker_reference="broker-order-1",
                    execution_id=None,
                    evidence_payload={"case": "terminal_race"},
                )
            )
            values.update(
                sequence_no=3,
                event_type="settled",
                state="settled",
                settlement_source=settlement.source,
                settlement_outcome=settlement.outcome,
                broker_reference=settlement.broker_reference,
                settlement_evidence_json=settlement.evidence_json,
                settlement_evidence_sha256=settlement.evidence_sha256,
                settled_at=database_now(session),
            )
            barrier.wait(timeout=10)
            try:
                append_full_state_event(session, receipt_id=receipt_id, values=values)
                commit_or_rollback(session)
            except DBAPIError:
                session.rollback()
                return "fenced"
            return "settled"

    with ThreadPoolExecutor(max_workers=2) as executor:
        return list(executor.map(settle, ("acknowledged", "reconciled")))


def _assert_receipt_indexes(schema_engine: Engine) -> None:
    inspector = inspect(schema_engine)
    assert {
        "uq_broker_mutation_receipt_client",
        "uq_broker_mutation_receipt_intent",
    }.issubset(
        {item["name"] for item in inspector.get_indexes("broker_mutation_receipts")}
    )
    assert "uq_broker_mutation_receipt_event_seq" in {
        item["name"] for item in inspector.get_indexes("broker_mutation_receipt_events")
    }


def _assert_lifecycle_terminal_history(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
    terminal_results: tuple[
        BrokerMutationReceiptSnapshot,
        BrokerMutationReceiptSnapshot,
    ],
) -> None:
    assert {result.lifecycle.sequence_no for result in terminal_results} == {7}
    assert len({result.settlement.outcome for result in terminal_results}) == 1
    with sessions() as session:
        history = get_broker_mutation_receipt_history(session, receipt_id)
        assert [event.event_type for event in history] == [
            "primary_claimed",
            "broker_io_started",
            "recovery_claimed",
            "recovery_observed",
            "recovery_released",
            "recovery_claimed",
            "settled",
        ]
        assert list_due_broker_mutation_receipt_ids(session) == ()


def _assert_header_and_terminal_guards(
    schema_engine: Engine,
    sessions: sessionmaker[Session],
) -> None:
    decision_id = uuid.uuid4()
    client_request_id = "a" * 64
    claim_token = uuid.uuid4()
    with schema_engine.begin() as connection:
        insert_decision(
            connection,
            decision_id=decision_id,
            client_order_id=client_request_id,
        )
        insert_claimed(
            connection,
            decision_id=decision_id,
            client_order_id=client_request_id,
            claim_token=claim_token,
        )
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint="a" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="workflow-1",
            client_request_id=client_request_id,
            target=BrokerMutationTarget(kind="order", key=client_request_id),
            request_payload={"symbol": "AAPL", "qty": Decimal("1")},
            submission_claim_id=decision_id,
        )
    )
    receipt_id = _persist_low_level_receipt(
        sessions,
        intent,
        primary_token=claim_token,
        submission_claim_handle=DecisionSubmissionClaimHandle(
            decision_id=decision_id,
            claim_token=claim_token,
            fencing_epoch=1,
            account_label="paper",
            client_order_id=client_request_id,
            claim_owner="writer-a",
        ),
    )
    _assert_submit_claim_identity_is_unique(sessions, intent)
    _assert_raw_submit_header_guards(sessions, intent)
    _assert_linked_terminal_database_guard(sessions, receipt_id)
    assert_rejected(
        schema_engine,
        "UPDATE broker_mutation_receipts SET purpose = 'operator' WHERE id = :id",
        id=receipt_id,
    )
    assert_rejected(
        schema_engine,
        "DELETE FROM broker_mutation_receipt_events WHERE receipt_id = :id",
        id=receipt_id,
    )
    terminal_intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint="a" * 64,
            operation="cancel_order",
            risk_class="risk_neutral",
            purpose="operator",
            workflow_id="workflow-terminal-race",
            client_request_id="f" * 64,
            target=BrokerMutationTarget(kind="order", key="f" * 64),
            request_payload={"order_id": "broker-order-1"},
        )
    )
    terminal_receipt_id = _persist_low_level_receipt(sessions, terminal_intent)
    _append_low_level_broker_io(sessions, terminal_receipt_id)
    _assert_database_terminal_guards(sessions, terminal_receipt_id)
    outcomes = _race_incompatible_low_level_settlement(sessions, terminal_receipt_id)
    assert sorted(outcomes) == ["fenced", "settled"]
    with sessions() as session:
        history = load_receipt_event_history(session, terminal_receipt_id)
        assert [event.sequence_no for event in history] == [1, 2, 3]
        assert history[-1].state == "settled"


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL receipt test",
)
def test_postgres_receipts_are_immutable_contiguous_and_first_terminal_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"mutation_receipts_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        create_parent_tables(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0060_bm_evidence_envelopes")

        _assert_receipt_indexes(schema_engine)

        _assert_header_and_terminal_guards(schema_engine, sessions)
        with pytest.raises(
            DBAPIError,
            match="refusing to downgrade nonempty broker mutation evidence envelopes",
        ):
            command.downgrade(alembic, "0058_decision_submission_claims")
        assert inspect(schema_engine).has_table("broker_mutation_receipts")
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL receipt test",
)
def test_postgres_lifecycle_serializes_identity_recovery_and_terminal_races(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"mutation_lifecycle_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        create_parent_tables(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0060_bm_evidence_envelopes")

        client_request_id = "b" * 64
        intent = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label="paper",
                endpoint_fingerprint="a" * 64,
                operation="cancel_order",
                risk_class="risk_neutral",
                purpose="operator",
                workflow_id="workflow-race",
                client_request_id=client_request_id,
                target=BrokerMutationTarget(kind="order", key=client_request_id),
                request_payload={"order_id": "broker-order-race"},
            )
        )
        winner = _race_primary_acquisition(sessions, intent)
        primary_handle = winner.receipt.primary_handle
        receipt_id = winner.receipt.receipt_id
        broker_io = _race_io_start(sessions, primary_handle)
        assert broker_io.state == "broker_io"
        _force_recovery_due(schema_engine, receipt_id)
        with sessions() as session:
            assert list_due_broker_mutation_receipt_ids(session) == (receipt_id,)
        recovery_handle = _race_recovery_acquisition(sessions, receipt_id)
        recovery_handle = _advance_recovery_epoch(
            sessions,
            schema_engine,
            receipt_id,
            intent,
            recovery_handle,
        )
        terminal_results = _race_compatible_settlement(
            sessions,
            primary_handle,
            recovery_handle,
        )
        _assert_lifecycle_terminal_history(sessions, receipt_id, terminal_results)
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL receipt test",
)
def test_postgres_empty_receipt_downgrade_is_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"mutation_downgrade_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    schema_engine = create_engine(schema_url, future=True)
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        create_parent_tables(schema_engine)
        monkeypatch.setattr(
            settings,
            "db_dsn",
            schema_url.render_as_string(hide_password=False),
        )
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0060_bm_evidence_envelopes")
        command.downgrade(alembic, "0058_decision_submission_claims")

        inspector = inspect(schema_engine)
        assert not inspector.has_table("broker_mutation_receipts")
        assert not inspector.has_table("broker_mutation_receipt_events")
        assert inspector.has_table("trade_decision_submission_claims")
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()
