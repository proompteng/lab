from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import timedelta
from decimal import Decimal

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.trading.broker_mutation_receipts import (
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlementRequest,
    acquire_broker_mutation_receipt,
    acquire_broker_mutation_recovery,
    build_broker_mutation_recovery_observation,
    build_broker_mutation_settlement,
    mark_broker_mutation_io_started,
)
from app.trading.broker_mutation_receipts.canonicalization import (
    build_broker_mutation_intent,
    canonicalize_broker_mutation_evidence,
)
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    database_now,
    insert_receipt_header_if_absent,
    load_receipt_event_models,
)
from app.trading.broker_mutation_receipts.types import (
    BrokerMutationIntent,
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
    _copied_event_values,
    _force_recovery_due,
    _initial_event_values,
)


@dataclass(frozen=True, slots=True)
class _PostgresHarness:
    admin_engine: Engine
    schema_engine: Engine
    sessions: sessionmaker[Session]
    alembic: AlembicConfig
    schema: str


@contextmanager
def _postgres_harness(
    monkeypatch: pytest.MonkeyPatch,
    *,
    revision: str,
) -> Iterator[_PostgresHarness]:
    assert POSTGRES_DSN is not None
    schema = f"mutation_boundaries_{uuid.uuid4().hex}"
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
        command.upgrade(alembic, revision)
        yield _PostgresHarness(
            admin_engine=admin_engine,
            schema_engine=schema_engine,
            sessions=sessions,
            alembic=alembic,
            schema=schema,
        )
    finally:
        schema_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


def _cancel_intent(*, workflow_id: str, client_request_id: str) -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint="a" * 64,
            operation="cancel_order",
            risk_class="risk_neutral",
            purpose="operator",
            workflow_id=workflow_id,
            client_request_id=client_request_id,
            target=BrokerMutationTarget(kind="order", key=client_request_id),
            request_payload={"order_id": "broker-order-1"},
        )
    )


def _assert_sql_canonicalizer_matches_python(harness: _PostgresHarness) -> None:
    payloads = (
        {"a": 1, "z": [True, None, "snow 雪", {"quoted": '"\\'}]},
        {"decimal": Decimal("1.2300"), "nested": {"é": "café"}},
        {"integer": -17, "decimal_string": "1.0"},
    )
    with harness.schema_engine.connect() as connection:
        for payload in payloads:
            canonical_json, _ = canonicalize_broker_mutation_evidence(payload)
            rebuilt = connection.execute(
                text(
                    "SELECT torghut_bm_canonical_json_0060(CAST(:document AS json), 0)"
                ),
                {"document": canonical_json},
            ).scalar_one()
            assert rebuilt == canonical_json
            connection.execute(
                text(
                    "SELECT torghut_assert_bm_canonical_json_0060("
                    ":document, 'test corpus', 4096)"
                ),
                {"document": canonical_json},
            )


def _assert_sql_canonicalizer_rejects_ambiguous_json(
    harness: _PostgresHarness,
) -> None:
    invalid_documents = (
        '{"a":1,"a":1}',
        '{"a":{"b":1,"b":1}}',
        '{ "a":1}',
        '{"b":1,"a":2}',
        r'{"a":"\u0061"}',
        r'{"a":"e\u0301"}',
        r'{"a":"\u0001"}',
        '{"a":-0}',
        '{"a":1.0}',
        '{"a":1e0}',
    )
    for document in invalid_documents:
        with harness.schema_engine.connect() as connection:
            with pytest.raises(DBAPIError):
                connection.execute(
                    text(
                        "SELECT torghut_assert_bm_canonical_json_0060("
                        ":document, 'invalid corpus', 4096)"
                    ),
                    {"document": document},
                )


def _assert_duplicate_intent_insert_is_rejected(harness: _PostgresHarness) -> None:
    intent = _cancel_intent(workflow_id="duplicate-intent", client_request_id="d" * 64)
    duplicate_json = '{"account_label":"shadow",' + intent.canonical_intent_json[1:]
    duplicate_intent = replace(
        intent,
        canonical_intent_json=duplicate_json,
        canonical_intent_sha256=hashlib.sha256(duplicate_json.encode()).hexdigest(),
    )
    with harness.sessions() as session:
        with pytest.raises(DBAPIError, match="duplicate keys"):
            insert_receipt_header_if_absent(
                session,
                receipt_id=uuid.uuid4(),
                intent=duplicate_intent,
                creator_owner="writer-a",
                origin_writer_generation=1,
            )
        session.rollback()


def _acquire_unlinked_broker_io(
    harness: _PostgresHarness,
) -> tuple[BrokerMutationIntent, uuid.UUID]:
    intent = _cancel_intent(
        workflow_id="duplicate-evidence", client_request_id="e" * 64
    )
    with harness.sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="writer-a",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(primary_token=uuid.uuid4()),
        )
    with harness.sessions() as session:
        started = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
        )
    assert started.authorized
    return intent, acquired.receipt.receipt_id


def _assert_duplicate_recovery_evidence_is_rejected(
    harness: _PostgresHarness,
    intent: BrokerMutationIntent,
    receipt_id: uuid.UUID,
) -> None:
    _force_recovery_due(harness.schema_engine, receipt_id)
    with harness.sessions() as session:
        recovery = acquire_broker_mutation_recovery(
            session,
            receipt_id=receipt_id,
            recovery_owner="reconciler-a",
            writer_generation=1,
            options=BrokerMutationRecoveryAcquireOptions(recovery_token=uuid.uuid4()),
        )
    handle = recovery.receipt.recovery_handle if recovery.receipt is not None else None
    assert handle is not None
    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=intent.client_request_id,
            checked_target_key=intent.target.key,
            outcome="not_found",
            evidence_payload={"broker_status": "not_found"},
        )
    )
    duplicate_json = (
        '{"checked_client_request_id":"shadow",' + observation.evidence_json[1:]
    )
    with harness.sessions() as session:
        event = load_receipt_event_models(session, receipt_id)[-1]
        values = _copied_event_values(event)
        now = database_now(session)
        values.update(
            sequence_no=event.sequence_no + 1,
            event_type="recovery_observed",
            event_writer_generation=handle.recovery_writer_generation,
            recovery_after=now + timedelta(seconds=30),
            recovery_checked_at=now,
            recovery_observation_epoch=handle.recovery_epoch,
            recovery_outcome="not_found",
            recovery_evidence_json=duplicate_json,
            recovery_evidence_sha256=hashlib.sha256(
                duplicate_json.encode()
            ).hexdigest(),
        )
        with pytest.raises(DBAPIError, match="duplicate keys"):
            append_full_state_event(session, receipt_id=receipt_id, values=values)
        session.rollback()


def _assert_duplicate_settlement_evidence_is_rejected(
    harness: _PostgresHarness,
    receipt_id: uuid.UUID,
) -> None:
    settlement = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference="broker-order-1",
            execution_id=None,
            evidence_payload={"broker_status": "accepted"},
        )
    )
    duplicate_json = '{"broker_reference":"shadow",' + settlement.evidence_json[1:]
    with harness.sessions() as session:
        event = load_receipt_event_models(session, receipt_id)[-1]
        values = _copied_event_values(event)
        values.update(
            sequence_no=event.sequence_no + 1,
            event_type="settled",
            state="settled",
            event_writer_generation=event.primary_writer_generation,
            settlement_source="primary",
            settlement_outcome="acknowledged",
            broker_reference="broker-order-1",
            settlement_evidence_json=duplicate_json,
            settlement_evidence_sha256=hashlib.sha256(
                duplicate_json.encode()
            ).hexdigest(),
            settled_at=database_now(session),
        )
        with pytest.raises(DBAPIError, match="duplicate keys"):
            append_full_state_event(session, receipt_id=receipt_id, values=values)
        session.rollback()


@dataclass(frozen=True, slots=True)
class _LinkedFixture:
    intent: BrokerMutationIntent
    handle: DecisionSubmissionClaimHandle


def _linked_fixture(harness: _PostgresHarness, *, suffix: str) -> _LinkedFixture:
    decision_id = uuid.uuid4()
    claim_token = uuid.uuid4()
    client_request_id = (suffix * 64)[:64]
    with harness.schema_engine.begin() as connection:
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
            endpoint_fingerprint="b" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id=f"linked-{suffix}",
            client_request_id=client_request_id,
            target=BrokerMutationTarget(kind="order", key=client_request_id),
            request_payload={"symbol": "AAPL", "qty": Decimal("1")},
            submission_claim_id=decision_id,
        )
    )
    return _LinkedFixture(
        intent=intent,
        handle=DecisionSubmissionClaimHandle(
            decision_id=decision_id,
            claim_token=claim_token,
            fencing_epoch=1,
            account_label="paper",
            client_order_id=client_request_id,
            claim_owner="writer-a",
        ),
    )


def _assert_linked_initial_lease_is_bounded(harness: _PostgresHarness) -> None:
    fixture = _linked_fixture(harness, suffix="l")
    with harness.sessions() as session:
        receipt_id = uuid.uuid4()
        assert (
            insert_receipt_header_if_absent(
                session,
                receipt_id=receipt_id,
                intent=fixture.intent,
                creator_owner="writer-a",
                origin_writer_generation=1,
            )
            == receipt_id
        )
        now = database_now(session)
        values = _initial_event_values(
            now=now,
            token=uuid.uuid4(),
            submission_claim_handle=fixture.handle,
        )
        values["primary_lease_expires_at"] = now + timedelta(seconds=31)
        with pytest.raises(DBAPIError, match="linked primary acquisition mismatch"):
            append_full_state_event(session, receipt_id=receipt_id, values=values)
        session.rollback()
    with harness.sessions() as session:
        receipt_id = uuid.uuid4()
        assert (
            insert_receipt_header_if_absent(
                session,
                receipt_id=receipt_id,
                intent=fixture.intent,
                creator_owner="writer-a",
                origin_writer_generation=1,
            )
            == receipt_id
        )
        now = database_now(session)
        values = _initial_event_values(
            now=now,
            token=uuid.uuid4(),
            submission_claim_handle=replace(
                fixture.handle,
                claim_token=uuid.uuid4(),
            ),
        )
        with pytest.raises(DBAPIError, match="claim identity mismatch"):
            append_full_state_event(session, receipt_id=receipt_id, values=values)
        session.rollback()


def _assert_expired_claim_cannot_reserve_header(harness: _PostgresHarness) -> None:
    fixture = _linked_fixture(harness, suffix="x")
    with harness.schema_engine.begin() as connection:
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
            {"decision_id": fixture.handle.decision_id},
        )
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "ENABLE TRIGGER trg_guard_td_submission_claim"
            )
        )
    with harness.sessions() as session:
        with pytest.raises(DBAPIError, match="claim lease is not live"):
            insert_receipt_header_if_absent(
                session,
                receipt_id=uuid.uuid4(),
                intent=fixture.intent,
                creator_owner="writer-a",
                origin_writer_generation=1,
            )
        session.rollback()


def _assert_header_serializes_concurrent_release(harness: _PostgresHarness) -> None:
    fixture = _linked_fixture(harness, suffix="r")
    with harness.schema_engine.connect() as releaser:
        transaction = releaser.begin()
        now = releaser.execute(text("SELECT clock_timestamp()")).scalar_one()
        releaser.execute(
            text(
                "UPDATE trade_decision_submission_claims "
                "SET lease_expires_at = :now, released_at = :now, "
                "release_reason = 'concurrent test' "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"now": now, "decision_id": fixture.handle.decision_id},
        )
        with harness.sessions() as session:
            session.execute(text("SET LOCAL lock_timeout = '100ms'"))
            with pytest.raises(DBAPIError, match="lock timeout"):
                insert_receipt_header_if_absent(
                    session,
                    receipt_id=uuid.uuid4(),
                    intent=fixture.intent,
                    creator_owner="writer-a",
                    origin_writer_generation=1,
                )
            session.rollback()
        transaction.commit()
    with harness.sessions() as session:
        with pytest.raises(DBAPIError, match="claim lease is not live"):
            insert_receipt_header_if_absent(
                session,
                receipt_id=uuid.uuid4(),
                intent=fixture.intent,
                creator_owner="writer-a",
                origin_writer_generation=1,
            )
        session.rollback()


def _assert_linked_raw_events_follow_claim_lifecycle(harness: _PostgresHarness) -> None:
    fixture = _linked_fixture(harness, suffix="s")
    with harness.sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=fixture.intent,
            primary_owner="writer-a",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                submission_claim_handle=fixture.handle,
            ),
        )
    receipt_id = acquired.receipt.receipt_id
    for event_type in ("primary_renewed", "broker_io_started"):
        with harness.sessions() as session:
            event = load_receipt_event_models(session, receipt_id)[-1]
            values = _copied_event_values(event)
            if event_type == "primary_renewed":
                values.update(
                    sequence_no=event.sequence_no + 1,
                    event_type=event_type,
                    primary_lease_expires_at=(
                        event.primary_lease_expires_at + timedelta(seconds=1)
                    ),
                )
                error = "renewal is forbidden"
            else:
                now = database_now(session)
                values.update(
                    sequence_no=event.sequence_no + 1,
                    event_type=event_type,
                    state="broker_io",
                    broker_io_started_at=now,
                    recovery_after=now + timedelta(seconds=120),
                )
                error = "broker I/O lifecycle mismatch"
            with pytest.raises(DBAPIError, match=error):
                append_full_state_event(session, receipt_id=receipt_id, values=values)
            session.rollback()


def _take_over_linked_claim_only(
    harness: _PostgresHarness,
    fixture: _LinkedFixture,
    *,
    receipt_id: uuid.UUID,
) -> DecisionSubmissionClaimHandle:
    with harness.schema_engine.begin() as connection:
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
            {"decision_id": fixture.handle.decision_id},
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
            {"receipt_id": receipt_id},
        )
        connection.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events "
                "ENABLE TRIGGER trg_guard_bm_receipt_event"
            )
        )
    with harness.sessions() as session:
        claim = acquire_decision_submission_claim(
            session,
            decision_id=fixture.handle.decision_id,
            client_order_id=fixture.intent.client_request_id,
            claim_owner="writer-b",
            options=DecisionSubmissionClaimAcquireOptions(
                claim_token=uuid.uuid4(),
            ),
        )
    assert claim.outcome == "acquired"
    assert claim.claim is not None
    return claim.claim.handle


def _assert_linked_takeover_binds_primary_owner(harness: _PostgresHarness) -> None:
    fixture = _linked_fixture(harness, suffix="t")
    with harness.sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=fixture.intent,
            primary_owner="writer-a",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                submission_claim_handle=fixture.handle,
            ),
        )
    receipt_id = acquired.receipt.receipt_id
    claim_handle = _take_over_linked_claim_only(
        harness,
        fixture,
        receipt_id=receipt_id,
    )
    with harness.sessions() as session:
        event = load_receipt_event_models(session, receipt_id)[-1]
        values = _copied_event_values(event)
        now = database_now(session)
        values.update(
            sequence_no=event.sequence_no + 1,
            event_type="primary_claimed",
            state="claimed",
            event_writer_generation=2,
            primary_token=uuid.uuid4(),
            primary_epoch=event.primary_epoch + 1,
            primary_owner="wrong-owner",
            primary_writer_generation=2,
            submission_claim_token=claim_handle.claim_token,
            submission_claim_fencing_epoch=claim_handle.fencing_epoch,
            submission_claim_owner=claim_handle.claim_owner,
            primary_claimed_at=now,
            primary_lease_expires_at=now + timedelta(seconds=30),
            released_at=None,
            release_reason=None,
        )
        with pytest.raises(DBAPIError, match="claim identity mismatch"):
            append_full_state_event(session, receipt_id=receipt_id, values=values)
        session.rollback()


def _insert_0059_parent_state(harness: _PostgresHarness) -> None:
    intent = _cancel_intent(workflow_id="parent-state", client_request_id="p" * 64)
    receipt_id = uuid.uuid4()
    event_id = uuid.uuid4()
    with harness.sessions() as session:
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
        values = _initial_event_values(now=now, token=uuid.uuid4())
        for key in (
            "submission_claim_token",
            "submission_claim_fencing_epoch",
            "submission_claim_owner",
        ):
            values.pop(key)
        columns = ("id", "receipt_id", *values.keys())
        statement = text(
            "INSERT INTO broker_mutation_receipt_events ("
            + ",".join(columns)
            + ") VALUES ("
            + ",".join(f":{column}" for column in columns)
            + ")"
        )
        session.execute(
            statement,
            {"id": event_id, "receipt_id": receipt_id, **values},
        )
        session.commit()


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for PostgreSQL boundary tests",
)
def test_postgres_0060_enforces_canonical_and_linked_boundaries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _postgres_harness(
        monkeypatch, revision="0060_bm_evidence_envelopes"
    ) as harness:
        _assert_sql_canonicalizer_matches_python(harness)
        _assert_sql_canonicalizer_rejects_ambiguous_json(harness)
        _assert_duplicate_intent_insert_is_rejected(harness)
        intent, receipt_id = _acquire_unlinked_broker_io(harness)
        _assert_duplicate_recovery_evidence_is_rejected(harness, intent, receipt_id)
        _assert_duplicate_settlement_evidence_is_rejected(harness, receipt_id)
        _assert_linked_initial_lease_is_bounded(harness)
        _assert_expired_claim_cannot_reserve_header(harness)
        _assert_header_serializes_concurrent_release(harness)
        _assert_linked_raw_events_follow_claim_lifecycle(harness)
        _assert_linked_takeover_binds_primary_owner(harness)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for PostgreSQL boundary tests",
)
def test_postgres_0060_refuses_nonempty_0059_parent_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _postgres_harness(
        monkeypatch, revision="0059_broker_mutation_receipts"
    ) as harness:
        _insert_0059_parent_state(harness)
        with pytest.raises(
            DBAPIError,
            match="refusing to upgrade nonempty unsafe 0059",
        ):
            command.upgrade(harness.alembic, "0060_bm_evidence_envelopes")
        with harness.schema_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "0059_broker_mutation_receipts"
            )
            assert (
                connection.execute(
                    text(
                        "SELECT to_regprocedure("
                        "'torghut_bm_canonical_json_0060(json,integer)')"
                    )
                ).scalar_one_or_none()
                is None
            )


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for PostgreSQL boundary tests",
)
def test_postgres_0060_empty_downgrade_removes_claim_identity_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _postgres_harness(
        monkeypatch,
        revision="0060_bm_evidence_envelopes",
    ) as harness:
        command.downgrade(harness.alembic, "0059_broker_mutation_receipts")
        with harness.schema_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "0059_broker_mutation_receipts"
            )
            assert (
                connection.execute(
                    text(
                        "SELECT to_regprocedure("
                        "'torghut_bm_canonical_json_0060(json,integer)')"
                    )
                ).scalar_one_or_none()
                is None
            )
            columns = connection.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = current_schema() "
                    "AND table_name = 'broker_mutation_receipt_events' "
                    "AND column_name LIKE 'submission_claim_%'"
                )
            ).scalars()
            assert tuple(columns) == ()
