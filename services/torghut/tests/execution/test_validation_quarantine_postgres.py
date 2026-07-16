from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone

import pytest
from alembic.config import Config as AlembicConfig
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import BrokerMutationReceiptEvent
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlementRequest,
    BrokerMutationSettlement,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    acquire_broker_mutation_recovery,
    build_broker_mutation_intent,
    build_broker_mutation_recovery_observation,
    build_broker_mutation_settlement,
    fingerprint_broker_endpoint,
    mark_broker_mutation_io_started,
    record_broker_mutation_recovery_observation,
    release_broker_mutation_recovery,
    settle_broker_mutation_operator_confirmation,
)
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    database_now,
    full_state_values_from_event,
)
from app.trading.infrastructure_validation import (
    infrastructure_validation_client_order_id,
    infrastructure_validation_request_payload,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_schema_engines,
    drop_schema,
)
from tests.execution.infrastructure_validation_postgres_support import (
    upgrade_reduction_schema,
    validation_fixture,
)


def _age_latest_event(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
    *,
    recovery_due: bool,
) -> None:
    with sessions() as session:
        session.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events DISABLE TRIGGER "
                "trg_guard_bm_receipt_event_update_delete"
            )
        )
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        latest.broker_io_started_at = database_now(session) - timedelta(minutes=2)
        if recovery_due:
            latest.recovery_after = database_now(session) - timedelta(seconds=1)
            if latest.recovery_lease_expires_at is not None:
                latest.recovery_lease_started_at = database_now(session) - timedelta(
                    minutes=2
                )
                latest.recovery_lease_expires_at = database_now(session) - timedelta(
                    minutes=1
                )
        session.flush()
        session.execute(
            text(
                "ALTER TABLE broker_mutation_receipt_events ENABLE TRIGGER "
                "trg_guard_bm_receipt_event_update_delete"
            )
        )
        session.commit()


def _seed_expired_validation_receipt(
    sessions: sessionmaker[Session],
) -> tuple[uuid.UUID, str, str]:
    now = datetime.now(timezone.utc)
    permit, plan = validation_fixture(now, permit_id=f"ivp-{uuid.uuid4().hex}")
    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label=permit.account_label,
            endpoint_fingerprint=fingerprint_broker_endpoint(
                str(permit.broker_base_url)
            ),
            operation="submit_order",
            risk_class="risk_neutral",
            purpose="control_plane_validation",
            workflow_id=client_order_id,
            client_request_id=client_order_id,
            target=BrokerMutationTarget(kind="order", key=client_order_id),
            request_payload=infrastructure_validation_request_payload(permit, plan),
        )
    )
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="validation-writer",
            writer_generation=1,
        )
        started = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
            recovery_seconds=30,
        )
    receipt_id = started.receipt.receipt_id
    _age_latest_event(sessions, receipt_id, recovery_due=True)
    with sessions() as session:
        recovery = acquire_broker_mutation_recovery(
            session,
            receipt_id=receipt_id,
            recovery_owner="recovery-reader",
            writer_generation=2,
            options=BrokerMutationRecoveryAcquireOptions(lease_seconds=30),
        )
    assert recovery.receipt is not None and recovery.receipt.recovery_handle is not None
    handle = recovery.receipt.recovery_handle
    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=client_order_id,
            checked_target_key=client_order_id,
            outcome="not_found",
            evidence_payload={
                "schema_version": "torghut.broker-submit-recovery-observation.v1",
                "resolution_state": "expired",
                "absence_proof_complete": True,
                "operator_confirmation_required": True,
                "automatic_resubmission_attempted": False,
            },
        )
    )
    with sessions() as session:
        record_broker_mutation_recovery_observation(
            session,
            handle=handle,
            observation=observation,
            retry_seconds=3600,
        )
    with sessions() as session:
        released = release_broker_mutation_recovery(session, handle=handle)
    _age_latest_event(sessions, receipt_id, recovery_due=False)
    assert released.recovery.evidence_sha256 is not None
    return receipt_id, intent.canonical_intent_sha256, released.recovery.evidence_sha256


def _settlement(
    *,
    receipt_id: uuid.UUID,
    client_order_id: str,
    intent_sha256: str,
    recovery_sha256: str,
    include_history_complete: bool = True,
    evidence_overrides: Mapping[str, object] | None = None,
) -> BrokerMutationSettlement:
    payload: dict[str, object] = {
        "schema_version": "torghut.infrastructure-validation-quarantine-closure.v1",
        "receipt_id": str(receipt_id),
        "client_order_id": client_order_id,
        "intent_sha256": intent_sha256,
        "account_label": "dedicated-validation-paper",
        "endpoint_fingerprint": fingerprint_broker_endpoint(
            "https://paper-api.alpaca.markets"
        ),
        "operator_id": "postgres-test-operator",
        "support_confirmation_reference": None,
        "confirmation_reason": "paper_ioc_future_exposure_impossible",
        "order_existence_resolution": "unresolved",
        "prior_recovery_evidence_sha256": recovery_sha256,
        "exact_client_order_lookup": "not_found",
        "history_count": 0,
        "history_match_count": 0,
        "open_order_count": 0,
        "position_count": 0,
        "account_number": "dedicated-validation-paper",
        "account_status": "ACTIVE",
        "account_blocked": False,
        "trading_blocked": False,
        "transfers_blocked": False,
        "time_in_force": "ioc",
        "evidence_tag": "non_promotable_validation",
        "promotable": False,
        "automatic_resubmission_attempted": False,
        "broker_mutation_attempted": False,
        "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if include_history_complete:
        payload["history_complete"] = True
    if evidence_overrides:
        payload.update(evidence_overrides)
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="operator_confirmation",
            outcome="validation_quarantine_closed",
            broker_reference=None,
            execution_id=None,
            evidence_payload=payload,
        )
    )


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the validation quarantine test",
)
def test_postgres_validation_quarantine_requires_complete_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "validation_quarantine"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        upgrade_reduction_schema(
            alembic,
            schema_engine,
            target="0077_validation_quarantine",
        )
        receipt_id, intent_sha256, recovery_sha256 = _seed_expired_validation_receipt(
            sessions
        )
        with sessions() as session:
            latest = session.execute(
                select(BrokerMutationReceiptEvent)
                .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
            invalid = _settlement(
                receipt_id=receipt_id,
                client_order_id=latest.receipt.client_request_id,
                intent_sha256=intent_sha256,
                recovery_sha256=recovery_sha256,
                include_history_complete=False,
            )
            values = full_state_values_from_event(latest)
            values.update(
                sequence_no=latest.sequence_no + 1,
                event_type="settled",
                state="settled",
                event_writer_generation=99,
                settlement_source=invalid.source,
                settlement_outcome=invalid.outcome,
                broker_reference=None,
                execution_id=None,
                settlement_evidence_json=invalid.evidence_json,
                settlement_evidence_sha256=invalid.evidence_sha256,
                settled_at=database_now(session),
            )
            with pytest.raises(DBAPIError, match="evidence is invalid"):
                append_full_state_event(session, receipt_id=receipt_id, values=values)
            session.rollback()

        for evidence_overrides in (
            {"operator_id": None},
            {"history_count": None},
            {"history_match_count": None},
            {"open_order_count": None},
            {"position_count": None},
            {"observed_at": None},
        ):
            with sessions() as session:
                latest = session.execute(
                    select(BrokerMutationReceiptEvent)
                    .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
                    .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                    .limit(1)
                ).scalar_one()
                invalid = _settlement(
                    receipt_id=receipt_id,
                    client_order_id=latest.receipt.client_request_id,
                    intent_sha256=intent_sha256,
                    recovery_sha256=recovery_sha256,
                    evidence_overrides=evidence_overrides,
                )
                values = full_state_values_from_event(latest)
                values.update(
                    sequence_no=latest.sequence_no + 1,
                    event_type="settled",
                    state="settled",
                    event_writer_generation=99,
                    settlement_source=invalid.source,
                    settlement_outcome=invalid.outcome,
                    broker_reference=None,
                    execution_id=None,
                    settlement_evidence_json=invalid.evidence_json,
                    settlement_evidence_sha256=invalid.evidence_sha256,
                    settled_at=database_now(session),
                )
                with pytest.raises(DBAPIError, match="evidence is invalid"):
                    append_full_state_event(
                        session,
                        receipt_id=receipt_id,
                        values=values,
                    )
                session.rollback()

        with sessions() as session:
            latest = session.execute(
                select(BrokerMutationReceiptEvent)
                .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
            valid = _settlement(
                receipt_id=receipt_id,
                client_order_id=latest.receipt.client_request_id,
                intent_sha256=intent_sha256,
                recovery_sha256=recovery_sha256,
            )
            settled = settle_broker_mutation_operator_confirmation(
                session,
                receipt_id=receipt_id,
                writer_generation=100,
                settlement=valid,
            )
        assert settled.state == "settled"
        assert settled.settlement.source == "operator_confirmation"
        assert settled.settlement.outcome == "validation_quarantine_closed"
        assert settled.settlement.broker_reference is None
        assert settled.settlement.execution_id is None
    finally:
        drop_schema(schema, admin_engine, schema_engine)
