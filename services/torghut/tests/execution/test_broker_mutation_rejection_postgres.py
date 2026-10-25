from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone

import pytest
from alembic.config import Config as AlembicConfig
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import BrokerMutationReceiptEvent
from app.trading.broker_mutation_receipts import (
    BrokerMutationExplicitRejection,
    BrokerMutationIoPermit,
    BrokerMutationSettlement,
    validate_broker_mutation_io_permit,
)
from app.trading.broker_mutation_coordinator import (
    BrokerMutationAlreadyProcessed,
    BrokerMutationCoordinator,
    BrokerMutationRejected,
    InfrastructureValidationOrderSubmission,
    UnlinkedMutationCallbacks,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_schema_engines,
    drop_schema,
)
from tests.execution.infrastructure_validation_postgres_support import (
    upgrade_validation_submit_schema,
    validation_fixture,
)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for explicit rejection settlement",
)
def test_postgres_validation_explicit_rejection_is_terminal_and_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "validation_rejection"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    now = datetime.now(timezone.utc)
    permit, plan = validation_fixture(now, permit_id="ivp-explicit-rejection")
    request = InfrastructureValidationOrderSubmission(
        permit=permit,
        plan=plan,
        account_label=permit.account_label,
        endpoint_url="https://paper-api.alpaca.markets",
    )
    calls = 0

    def broker_call(permit_to_consume: BrokerMutationIoPermit) -> Mapping[str, object]:
        nonlocal calls
        validate_broker_mutation_io_permit(permit_to_consume)
        calls += 1
        raise BrokerMutationExplicitRejection(
            broker_status="http_403",
            rejection_code="40310000",
            detail="cost basis below broker minimum",
        )

    def forbidden_success(_result: Mapping[str, object]) -> None:
        raise AssertionError("rejection must not run success persistence")

    def forbidden_settlement(
        _result: Mapping[str, object],
    ) -> BrokerMutationSettlement:
        raise AssertionError("rejection must use coordinator settlement")

    callbacks = UnlinkedMutationCallbacks(
        broker_call=broker_call,
        persist_terminal=forbidden_success,
        build_settlement=forbidden_settlement,
    )
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        upgrade_validation_submit_schema(alembic, schema_engine)

        with (
            sessions() as session,
            pytest.raises(
                BrokerMutationRejected,
                match="unlinked_submission_broker_rejected.*40310000",
            ),
        ):
            BrokerMutationCoordinator(
                "validation-rejection"
            ).submit_infrastructure_validation_order(
                session,
                request=request,
                callbacks=callbacks,
                now=now,
            )

        with sessions() as session, pytest.raises(BrokerMutationAlreadyProcessed):
            BrokerMutationCoordinator(
                "validation-rejection-replay"
            ).submit_infrastructure_validation_order(
                session,
                request=request,
                callbacks=callbacks,
                now=now,
            )

        with sessions() as session:
            latest = session.execute(
                select(BrokerMutationReceiptEvent)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
        assert calls == 1
        assert (
            latest.state,
            latest.settlement_source,
            latest.settlement_outcome,
            latest.broker_reference,
        ) == ("settled", "primary", "rejected", None)
    finally:
        drop_schema(schema, admin_engine, schema_engine)
