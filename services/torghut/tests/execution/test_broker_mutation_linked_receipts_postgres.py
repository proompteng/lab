from __future__ import annotations

import uuid
from dataclasses import dataclass, replace
from decimal import Decimal
from unittest.mock import patch

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import TradeDecisionSubmissionClaim
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptAcquireResult,
    BrokerMutationReceiptConflictError,
    BrokerMutationReceiptFenceError,
    BrokerMutationReceiptHandle,
    BrokerMutationReceiptValidationError,
    BrokerMutationSettlementRequest,
    acquire_broker_mutation_recovery,
    acquire_broker_mutation_receipt,
    build_broker_mutation_settlement,
    get_broker_mutation_receipt_history,
    mark_broker_mutation_io_started,
    renew_broker_mutation_receipt,
    settle_broker_mutation_primary,
)
from app.trading.broker_mutation_receipts.canonicalization import (
    build_broker_mutation_intent,
)
from app.trading.broker_mutation_receipts.types import (
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
)
from app.trading.decision_submission_claims import (
    DecisionSubmissionClaimAcquireOptions,
    DecisionSubmissionClaimHandle,
    acquire_decision_submission_claim,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_parent_tables,
    insert_claimed,
    insert_decision,
)
from tests.execution.test_broker_mutation_receipts_postgres import (
    _force_recovery_due,
    _race_io_start,
    _race_primary_acquisition,
)


def _assert_stale_linked_claim_is_fenced(
    sessions: sessionmaker[Session],
    intent: BrokerMutationIntent,
    handle: DecisionSubmissionClaimHandle,
) -> None:
    stale_handles = (
        replace(handle, claim_token=uuid.uuid4()),
        replace(handle, fencing_epoch=handle.fencing_epoch + 1),
        replace(handle, claim_owner="writer-b"),
        replace(handle, client_order_id="e" * 64),
    )
    for stale_handle in stale_handles:
        with sessions() as session:
            with pytest.raises(
                (BrokerMutationReceiptFenceError, BrokerMutationReceiptValidationError)
            ):
                acquire_broker_mutation_receipt(
                    session,
                    intent=intent,
                    primary_owner=stale_handle.claim_owner,
                    writer_generation=1,
                    options=BrokerMutationReceiptAcquireOptions(
                        submission_claim_handle=stale_handle
                    ),
                )


def _assert_failed_linked_boundary_rolls_back(
    schema_engine: Engine,
    sessions: sessionmaker[Session],
    receipt_handle: BrokerMutationReceiptHandle,
    claim_handle: DecisionSubmissionClaimHandle,
) -> None:
    with schema_engine.begin() as connection:
        connection.execute(
            text(
                "CREATE FUNCTION torghut_test_fail_receipt_io() RETURNS trigger "
                "LANGUAGE plpgsql AS $$ BEGIN "
                "IF NEW.event_type = 'broker_io_started' THEN "
                "RAISE EXCEPTION 'injected receipt append failure'; END IF; "
                "RETURN NEW; END; $$"
            )
        )
        connection.execute(
            text(
                "CREATE TRIGGER trg_test_fail_receipt_io BEFORE INSERT "
                "ON broker_mutation_receipt_events FOR EACH ROW "
                "EXECUTE FUNCTION torghut_test_fail_receipt_io()"
            )
        )
    with sessions() as session:
        with pytest.raises(DBAPIError, match="injected receipt append failure"):
            mark_broker_mutation_io_started(
                session,
                handle=receipt_handle,
                submission_claim_handle=claim_handle,
            )
    with schema_engine.begin() as connection:
        state = connection.execute(
            text(
                "SELECT state FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": claim_handle.decision_id},
        ).scalar_one()
        assert state == "claimed"
        connection.execute(
            text(
                "DROP TRIGGER trg_test_fail_receipt_io "
                "ON broker_mutation_receipt_events"
            )
        )
        connection.execute(text("DROP FUNCTION torghut_test_fail_receipt_io()"))


def _assert_unexpected_linked_boundary_failure_rolls_back(
    schema_engine: Engine,
    sessions: sessionmaker[Session],
    receipt_handle: BrokerMutationReceiptHandle,
    claim_handle: DecisionSubmissionClaimHandle,
) -> None:
    with sessions() as session:
        with patch(
            "app.trading.broker_mutation_receipts.transitions.append_full_state_event",
            side_effect=RuntimeError("injected unexpected failure"),
        ):
            with pytest.raises(RuntimeError, match="injected unexpected failure"):
                mark_broker_mutation_io_started(
                    session,
                    handle=receipt_handle,
                    submission_claim_handle=claim_handle,
                )
        assert not session.in_transaction()
    with schema_engine.connect() as connection:
        state = connection.execute(
            text(
                "SELECT state FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": claim_handle.decision_id},
        ).scalar_one()
    assert state == "claimed"


def _take_over_expired_linked_submit(
    schema_engine: Engine,
    sessions: sessionmaker[Session],
    intent: BrokerMutationIntent,
    receipt: BrokerMutationReceiptAcquireResult,
) -> tuple[BrokerMutationReceiptAcquireResult, DecisionSubmissionClaimHandle]:
    decision_id = intent.submission_claim_id
    assert decision_id is not None
    with schema_engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "DISABLE TRIGGER trg_guard_td_submission_claim"
            )
        )
        connection.execute(
            text(
                "UPDATE trade_decision_submission_claims "
                "SET lease_expires_at = clock_timestamp() - interval '1 second' "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": decision_id},
        )
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "ENABLE TRIGGER trg_guard_td_submission_claim"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events "
                "DISABLE TRIGGER trg_guard_bm_receipt_event"
            )
        )
        connection.execute(
            text(
                "UPDATE broker_mutation_receipt_events "
                "SET primary_claimed_at = clock_timestamp() - interval '2 seconds', "
                "primary_lease_expires_at = clock_timestamp() - interval '1 second' "
                "WHERE receipt_id = :receipt_id"
            ),
            {"receipt_id": receipt.receipt.receipt_id},
        )
        connection.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events "
                "ENABLE TRIGGER trg_guard_bm_receipt_event"
            )
        )
    with sessions() as session:
        claim = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=intent.client_request_id,
            claim_owner="writer-b",
            options=DecisionSubmissionClaimAcquireOptions(claim_token=uuid.uuid4()),
        )
    assert claim.outcome == "acquired"
    assert claim.claim is not None
    with sessions() as session:
        taken_over = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="writer-b",
            writer_generation=2,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                submission_claim_handle=claim.claim.handle,
            ),
        )
    assert taken_over.outcome == "acquired"
    assert taken_over.receipt.primary_handle.primary_epoch == 2
    return taken_over, claim.claim.handle


@dataclass(frozen=True, slots=True)
class _LinkedSubmitFixture:
    decision_id: uuid.UUID
    intent: BrokerMutationIntent
    claim_handle: DecisionSubmissionClaimHandle


def _create_linked_submit_fixture(schema_engine: Engine) -> _LinkedSubmitFixture:
    decision_id = uuid.uuid4()
    client_request_id = "c" * 64
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
            workflow_id="workflow-linked",
            client_request_id=client_request_id,
            target=BrokerMutationTarget(kind="order", key=client_request_id),
            request_payload={"symbol": "AAPL", "qty": Decimal("1")},
            submission_claim_id=decision_id,
        )
    )
    return _LinkedSubmitFixture(
        decision_id=decision_id,
        intent=intent,
        claim_handle=DecisionSubmissionClaimHandle(
            decision_id=decision_id,
            claim_token=claim_token,
            fencing_epoch=1,
            account_label="paper",
            client_order_id=client_request_id,
            claim_owner="writer-a",
        ),
    )


def _assert_linked_lease_bounds_and_takeover(
    schema_engine: Engine,
    sessions: sessionmaker[Session],
    fixture: _LinkedSubmitFixture,
    winner: BrokerMutationReceiptAcquireResult,
) -> tuple[BrokerMutationReceiptAcquireResult, DecisionSubmissionClaimHandle]:
    with sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptValidationError,
            match="renewal_forbidden",
        ):
            renew_broker_mutation_receipt(
                session,
                handle=winner.receipt.primary_handle,
            )
    with sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptValidationError,
            match="linked_submission_lease_too_large",
        ):
            acquire_broker_mutation_receipt(
                session,
                intent=fixture.intent,
                primary_owner=fixture.claim_handle.claim_owner,
                writer_generation=1,
                options=BrokerMutationReceiptAcquireOptions(
                    lease_seconds=31,
                    submission_claim_handle=fixture.claim_handle,
                ),
            )
    return _take_over_expired_linked_submit(
        schema_engine,
        sessions,
        fixture.intent,
        winner,
    )


def _assert_linked_post_io_contract(
    schema_engine: Engine,
    sessions: sessionmaker[Session],
    fixture: _LinkedSubmitFixture,
    winner: BrokerMutationReceiptAcquireResult,
    claim_handle: DecisionSubmissionClaimHandle,
) -> None:
    receipt_id = winner.receipt.receipt_id
    with sessions() as session:
        repeated = acquire_broker_mutation_receipt(
            session,
            intent=fixture.intent,
            primary_owner=claim_handle.claim_owner,
            writer_generation=2,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                submission_claim_handle=claim_handle,
            ),
        )
    assert repeated.outcome == "busy"
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
        with pytest.raises(
            BrokerMutationReceiptValidationError,
            match="atomic_terminal_coordinator",
        ):
            settle_broker_mutation_primary(
                session,
                handle=winner.receipt.primary_handle,
                settlement=rejected,
            )
    with sessions() as session:
        claim = session.get(TradeDecisionSubmissionClaim, fixture.decision_id)
        assert claim is not None
        assert claim.state == "broker_io"
        history = get_broker_mutation_receipt_history(session, receipt_id)
        assert [event.event_type for event in history] == [
            "primary_claimed",
            "primary_claimed",
            "broker_io_started",
        ]
        assert history[-1].snapshot.submission_claim_handle == claim_handle
    _force_recovery_due(schema_engine, receipt_id)
    with sessions() as session:
        recovery = acquire_broker_mutation_recovery(
            session,
            receipt_id=receipt_id,
            recovery_owner="reconciler-a",
            writer_generation=1,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=uuid.uuid4(),
            ),
        )
    assert recovery.outcome == "acquired"
    with schema_engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "DISABLE TRIGGER trg_guard_td_submission_claim"
            )
        )
        connection.execute(
            text(
                "UPDATE trade_decision_submission_claims "
                "SET state = 'claimed', broker_io_started_at = NULL, "
                "recovery_after = NULL "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        )
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "ENABLE TRIGGER trg_guard_td_submission_claim"
            )
        )
    with sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptConflictError,
            match="linked_submission_lifecycle_mismatch:broker_io:claimed",
        ):
            acquire_broker_mutation_recovery(
                session,
                receipt_id=receipt_id,
                recovery_owner="reconciler-a",
                writer_generation=1,
                options=BrokerMutationRecoveryAcquireOptions(
                    recovery_token=uuid.uuid4(),
                ),
            )


def _assert_linked_submit_boundary_is_atomic(
    schema_engine: Engine,
    sessions: sessionmaker[Session],
) -> None:
    fixture = _create_linked_submit_fixture(schema_engine)
    _assert_stale_linked_claim_is_fenced(
        sessions,
        fixture.intent,
        fixture.claim_handle,
    )
    winner = _race_primary_acquisition(
        sessions,
        fixture.intent,
        fixture.claim_handle,
    )
    winner, claim_handle = _assert_linked_lease_bounds_and_takeover(
        schema_engine,
        sessions,
        fixture,
        winner,
    )
    _assert_failed_linked_boundary_rolls_back(
        schema_engine,
        sessions,
        winner.receipt.primary_handle,
        claim_handle,
    )
    _assert_unexpected_linked_boundary_failure_rolls_back(
        schema_engine,
        sessions,
        winner.receipt.primary_handle,
        claim_handle,
    )
    broker_io = _race_io_start(sessions, winner.receipt.primary_handle, claim_handle)
    assert broker_io.state == "broker_io"
    _assert_linked_post_io_contract(
        schema_engine,
        sessions,
        fixture,
        winner,
        claim_handle,
    )


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the opt-in PostgreSQL receipt test",
)
def test_postgres_linked_submit_uses_one_atomic_bounded_permit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_DSN is not None
    schema = f"mutation_linked_{uuid.uuid4().hex}"
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
        _assert_linked_submit_boundary_is_atomic(schema_engine, sessions)
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()
