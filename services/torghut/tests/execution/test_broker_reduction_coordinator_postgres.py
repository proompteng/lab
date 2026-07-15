from __future__ import annotations

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import BrokerMutationReceipt
from app.trading.broker_mutation_coordinator import (
    BrokerMutationCoordinator,
    UnlinkedMutationCallbacks,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_schema_engines,
    drop_schema,
)


def _upgrade_reduction_schema(
    alembic: AlembicConfig,
    schema_engine: Engine,
) -> None:
    command.stamp(alembic, "0057_generic_multifactor_machine")
    command.upgrade(alembic, "0061_linked_submission_terminal")
    command.stamp(alembic, "0065_strategy_capital_compat")
    with schema_engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE torghut_options_contract_catalog (
                    contract_symbol TEXT PRIMARY KEY,
                    status TEXT NOT NULL
                )
                """
            )
        )
    command.upgrade(alembic, "0070_reduction_fencing")


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the reduction fencing test",
)
def test_postgres_unlinked_replacement_requires_exact_reduction_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "replacement_fencing"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    request_payload = {"limit_price": "100", "order_id": "order-1"}
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        _upgrade_reduction_schema(alembic, schema_engine)
        intent = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label="paper",
                endpoint_fingerprint="a" * 64,
                operation="replace_order",
                risk_class="risk_neutral",
                purpose="repricing",
                workflow_id="replace-order-1",
                client_request_id="replace-order-1",
                target=BrokerMutationTarget(kind="order", key="order-1"),
                request_payload=request_payload,
            )
        )

        with sessions() as session:
            BrokerMutationCoordinator("alpaca-replace-pg").execute_unlinked_mutation(
                session,
                intent=intent,
                callbacks=UnlinkedMutationCallbacks(
                    broker_call=lambda _permit: {
                        "id": "replacement-order-1",
                        "status": "accepted",
                    },
                    persist_terminal=lambda _result: None,
                    build_settlement=lambda result: build_broker_mutation_settlement(
                        BrokerMutationSettlementRequest(
                            source="primary",
                            outcome="acknowledged",
                            broker_reference=str(result["id"]),
                            execution_id=None,
                            evidence_payload={"status": result["status"]},
                        )
                    ),
                ),
            )

        with sessions() as session:
            session.add(
                BrokerMutationReceipt(
                    broker_route="alpaca",
                    account_label="paper",
                    endpoint_fingerprint="a" * 64,
                    operation="replace_order",
                    risk_class="risk_increasing",
                    purpose="repricing",
                    submission_claim_id=None,
                    workflow_id="invalid-replace-order-2",
                    client_request_id="invalid-replace-order-2",
                    target_kind="order",
                    target_key="order-2",
                    intent_schema_version="torghut.broker-mutation-intent.v1",
                    canonical_intent_json="{}",
                    canonical_intent_sha256="b" * 64,
                    creator_owner="invalid-replace-test",
                    origin_writer_generation=1,
                )
            )
            with pytest.raises(IntegrityError):
                session.commit()

        with sessions() as session:
            receipt = session.execute(
                select(BrokerMutationReceipt).where(
                    BrokerMutationReceipt.client_request_id == "replace-order-1"
                )
            ).scalar_one()
        assert (receipt.operation, receipt.risk_class, receipt.purpose) == (
            "replace_order",
            "risk_neutral",
            "repricing",
        )
    finally:
        drop_schema(schema, admin_engine, schema_engine)
