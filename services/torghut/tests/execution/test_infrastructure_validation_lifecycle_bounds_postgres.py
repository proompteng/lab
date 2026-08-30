from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import cast

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import BrokerMutationReceipt
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    build_broker_mutation_intent,
    fingerprint_broker_endpoint,
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
    validation_lifecycle_fixture,
)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for lifecycle migration compatibility",
)
def test_postgres_lifecycle_v2_preserves_released_v1_receipts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "lifecycle_v2_compatibility"
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
            target="0072_validation_lifecycle",
        )
        legacy_intent = _legacy_lifecycle_intent(
            datetime.now(timezone.utc),
            permit_suffix="released-v1",
        )
        with sessions() as session:
            acquire_broker_mutation_receipt(
                session,
                intent=legacy_intent,
                primary_owner="released-v1-regression",
                writer_generation=1,
            )

        command.upgrade(alembic, "0073_live_paper_bounds")
        with schema_engine.connect() as connection:
            assert (
                connection.scalar(
                    text(
                        "SELECT convalidated FROM pg_constraint "
                        "WHERE conrelid = 'broker_mutation_receipts'::regclass "
                        "AND conname = 'ck_bm_receipt_validation_authority'"
                    )
                )
                is True
            )
            upgraded_constraint = str(
                connection.scalar(
                    text(
                        "SELECT pg_get_constraintdef(oid, true) "
                        "FROM pg_constraint "
                        "WHERE conrelid = 'broker_mutation_receipts'::regclass "
                        "AND conname = 'ck_bm_receipt_validation_authority'"
                    )
                )
            )
            upgraded_lineage = str(
                connection.scalar(
                    text(
                        "SELECT pg_get_functiondef(to_regprocedure("
                        "'torghut_guard_bm_validation_lineage_0072()'))"
                    )
                )
            )
            upgraded_retirement_trigger_count = connection.scalar(
                text(
                    "SELECT count(*) FROM pg_trigger WHERE tgname = "
                    "'trg_reject_bm_validation_lifecycle_v1_0073'"
                )
            )
        assert (
            upgraded_lineage.count(
                "torghut.infrastructure-validation-lifecycle-plan.v2"
            )
            == 3
        )
        assert "root_plan_schema NOT IN" not in upgraded_lineage
        assert upgraded_retirement_trigger_count == 1
        assert (
            "WHEN 'torghut.infrastructure-validation-lifecycle-plan.v1'::text "
            "THEN 5::numeric"
        ) in upgraded_constraint
        assert (
            "WHEN 'torghut.infrastructure-validation-lifecycle-plan.v2'::text "
            "THEN 30::numeric"
        ) in upgraded_constraint
        with sessions() as session:
            assert (
                session.scalar(
                    select(BrokerMutationReceipt.id).where(
                        BrokerMutationReceipt.client_request_id
                        == legacy_intent.client_request_id
                    )
                )
                is not None
            )

        retired_v1 = _legacy_lifecycle_intent(
            datetime.now(timezone.utc),
            permit_suffix="retired-v1",
        )
        with sessions() as session:
            with pytest.raises(
                IntegrityError,
                match="lifecycle v1 receipts are read-only",
            ):
                acquire_broker_mutation_receipt(
                    session,
                    intent=retired_v1,
                    primary_owner="retired-v1-regression",
                    writer_generation=1,
                )

        command.downgrade(alembic, "0072_validation_lifecycle")
        with schema_engine.connect() as connection:
            downgraded_constraint = str(
                connection.scalar(
                    text(
                        "SELECT pg_get_constraintdef(oid, true) "
                        "FROM pg_constraint "
                        "WHERE conrelid = 'broker_mutation_receipts'::regclass "
                        "AND conname = 'ck_bm_receipt_validation_authority'"
                    )
                )
            )
            downgraded_lineage = str(
                connection.scalar(
                    text(
                        "SELECT pg_get_functiondef(to_regprocedure("
                        "'torghut_guard_bm_validation_lineage_0072()'))"
                    )
                )
            )
            downgraded_retirement_trigger_count = connection.scalar(
                text(
                    "SELECT count(*) FROM pg_trigger WHERE tgname = "
                    "'trg_reject_bm_validation_lifecycle_v1_0073'"
                )
            )
        assert "torghut.infrastructure-validation-lifecycle-plan.v1" in (
            downgraded_constraint
        )
        assert "torghut.infrastructure-validation-lifecycle-plan.v2" not in (
            downgraded_constraint
        )
        assert downgraded_lineage.count("root_plan_schema IS DISTINCT FROM") == 3
        assert downgraded_retirement_trigger_count == 0

        command.upgrade(alembic, "0073_live_paper_bounds")
    finally:
        drop_schema(schema, admin_engine, schema_engine)


def _legacy_lifecycle_intent(
    now: datetime,
    *,
    permit_suffix: str,
) -> BrokerMutationIntent:
    permit, plan = validation_lifecycle_fixture(
        now,
        permit_id=f"ivp-postgres-lifecycle-{permit_suffix}",
    )
    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    request_payload = copy.deepcopy(
        infrastructure_validation_request_payload(permit, plan)
    )
    broker_request = cast(dict[str, object], request_payload["broker_request"])
    validation = cast(dict[str, object], request_payload["infrastructure_validation"])
    permit_payload = cast(dict[str, object], validation["permit"])
    plan_payload = cast(dict[str, object], validation["test_plan"])

    broker_request.update(qty="0.00004", limit_price="67000")
    plan_payload.update(
        schema_version="torghut.infrastructure-validation-lifecycle-plan.v1",
        qty="0.00004",
        limit_price="67000",
        resting_close_limit_price="68000",
        replacement_close_limit_price="69000",
        partial_close_qty="0.00002",
    )
    permit_payload.update(
        max_notional_usd="5",
        max_loss_usd="5",
        test_plan_digest="a" * 64,
    )
    validation["test_plan_sha256"] = "a" * 64

    return build_broker_mutation_intent(
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
            request_payload=request_payload,
        )
    )
