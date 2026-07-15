from __future__ import annotations

import copy
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import (
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    ExecutionOrderEvent,
)
from app.trading.broker_mutation_coordinator import (
    BrokerMutationCoordinator,
    InfrastructureValidationOrderSubmission,
    UnlinkedMutationCallbacks,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
    fingerprint_broker_endpoint,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    infrastructure_validation_client_order_id,
    infrastructure_validation_order_plan_sha256,
    infrastructure_validation_request_payload,
    infrastructure_validation_terminal_state_sha256,
)
from app.trading.infrastructure_validation_records import (
    infrastructure_validation_lineage_payload,
    load_infrastructure_validation_evidence,
    tag_infrastructure_validation_event,
)
from app.trading.risk_reduction import (
    BrokerPositionObservation,
    BrokerReductionSnapshot,
    PositionCloseLeg,
    RiskReductionAuthorization,
    SubmitCloseOrderPlan,
    authorize_risk_reduction,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_schema_engines,
    drop_schema,
)
from tests.execution.infrastructure_validation_postgres_support import (
    upgrade_reduction_schema as _upgrade_reduction_schema,
    validation_lifecycle_fixture,
)


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
        command.downgrade(alembic, "0070_reduction_fencing")
        with schema_engine.connect() as connection:
            guard_count = connection.scalar(
                text(
                    "SELECT count(*) FROM pg_trigger "
                    "WHERE tgname = 'trg_guard_bm_validation_lineage_0071'"
                )
            )
        assert guard_count == 0
    finally:
        drop_schema(schema, admin_engine, schema_engine)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the validation lineage test",
)
def test_postgres_validation_descendant_requires_exact_root_parent_and_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "validation_lineage"
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
        _upgrade_reduction_schema(alembic, schema_engine)
        client_order_id = _seed_validation_root(sessions)
        with sessions() as session:
            evidence = load_infrastructure_validation_evidence(
                session,
                account_label="paper",
                client_order_id=client_order_id,
            )
        assert evidence is not None
        lineage = infrastructure_validation_lineage_payload(evidence)
        expired_intent = _replacement_intent(
            lineage=lineage,
            endpoint_fingerprint=evidence.endpoint_fingerprint,
            client_request_id="validation-replace-after-permit-expiry",
            order_id="validation-root-order-1",
        )
        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE broker_mutation_receipts ALTER COLUMN created_at "
                    "SET DEFAULT (clock_timestamp() + interval '10 minutes')"
                )
            )
        try:
            with sessions() as session:
                BrokerMutationCoordinator(
                    "validation-expired-lineage-pg"
                ).execute_unlinked_mutation(
                    session,
                    intent=expired_intent,
                    callbacks=UnlinkedMutationCallbacks(
                        broker_call=lambda _permit: {
                            "id": "validation-expired-replacement-1",
                            "status": "accepted",
                        },
                        persist_terminal=lambda _result: None,
                        build_settlement=lambda result: (
                            build_broker_mutation_settlement(
                                BrokerMutationSettlementRequest(
                                    source="primary",
                                    outcome="acknowledged",
                                    broker_reference=str(result["id"]),
                                    execution_id=None,
                                    evidence_payload={"status": result["status"]},
                                )
                            )
                        ),
                    ),
                )
        finally:
            with schema_engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE broker_mutation_receipts "
                        "ALTER COLUMN created_at SET DEFAULT now()"
                    )
                )
        valid_intent = _replacement_intent(
            lineage=lineage,
            endpoint_fingerprint=evidence.endpoint_fingerprint,
            client_request_id="validation-replace-valid",
            order_id="validation-root-order-1",
        )
        with sessions() as session:
            BrokerMutationCoordinator(
                "validation-lineage-pg"
            ).execute_unlinked_mutation(
                session,
                intent=valid_intent,
                callbacks=UnlinkedMutationCallbacks(
                    broker_call=lambda _permit: {
                        "id": "validation-replacement-1",
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
            descendant = load_infrastructure_validation_evidence(
                session,
                account_label="paper",
                client_order_id=None,
                alpaca_order_id="validation-replacement-1",
            )
        assert descendant is not None
        assert descendant.root_receipt_id == evidence.root_receipt_id
        assert descendant.receipt_id != evidence.receipt_id
        assert descendant.broker_order_id == "validation-replacement-1"
        cancel_intent = _cancel_intent(
            lineage=infrastructure_validation_lineage_payload(descendant),
            endpoint_fingerprint=evidence.endpoint_fingerprint,
            client_request_id="validation-cancel-valid",
            order_id="validation-replacement-1",
        )
        with sessions() as session:
            BrokerMutationCoordinator("validation-cancel-pg").execute_unlinked_mutation(
                session,
                intent=cancel_intent,
                callbacks=UnlinkedMutationCallbacks(
                    broker_call=lambda _permit: True,
                    persist_terminal=lambda _result: None,
                    build_settlement=lambda _result: build_broker_mutation_settlement(
                        BrokerMutationSettlementRequest(
                            source="primary",
                            outcome="acknowledged",
                            broker_reference="validation-cancel-valid",
                            execution_id=None,
                            evidence_payload={"canceled": True},
                        )
                    ),
                ),
            )
        with sessions() as session:
            cancel_receipt = session.execute(
                select(BrokerMutationReceipt).where(
                    BrokerMutationReceipt.client_request_id == "validation-cancel-valid"
                )
            ).scalar_one()
            cancel_terminal = session.execute(
                select(BrokerMutationReceiptEvent)
                .where(BrokerMutationReceiptEvent.receipt_id == cancel_receipt.id)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
        cancel_reference = str(cancel_terminal.broker_reference or "")
        assert cancel_reference
        cancel_parent_lineage = {
            **infrastructure_validation_lineage_payload(descendant),
            "parent_receipt_id": str(cancel_receipt.id),
            "parent_broker_order_id": cancel_reference,
        }

        forged_cases = (
            (
                "missing-root",
                {**lineage, "root_receipt_id": str(uuid.uuid4())},
                "validation-root-order-1",
            ),
            (
                "wrong-parent-reference",
                {**lineage, "parent_broker_order_id": "other-order"},
                "validation-root-order-1",
            ),
            ("cancel-parent", cancel_parent_lineage, cancel_reference),
            ("wrong-target", lineage, "other-order"),
            ("extra-key", {**lineage, "forged": True}, "validation-root-order-1"),
        )
        for name, forged_lineage, order_id in forged_cases:
            intent = _replacement_intent(
                lineage=forged_lineage,
                endpoint_fingerprint=evidence.endpoint_fingerprint,
                client_request_id=f"validation-replace-{name}",
                order_id=order_id,
            )
            with sessions() as session:
                session.add(_receipt_from_intent(intent))
                with pytest.raises(IntegrityError):
                    session.commit()
        with sessions() as session:
            session.add(
                _receipt_from_intent(
                    _close_intent(
                        lineage=lineage,
                        endpoint_fingerprint=evidence.endpoint_fingerprint,
                    )
                )
            )
            with pytest.raises(IntegrityError):
                session.commit()
        with pytest.raises(
            DBAPIError,
            match="cannot downgrade with validation-lineage receipts",
        ):
            command.downgrade(alembic, "0070_reduction_fencing")
    finally:
        drop_schema(schema, admin_engine, schema_engine)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the validation lifecycle test",
)
def test_postgres_lifecycle_close_requires_reconciled_position_and_fill_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "validation_lifecycle"
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
        _upgrade_reduction_schema(
            alembic,
            schema_engine,
            target="0073_live_paper_bounds",
        )
        for permit_suffix, partial_close_qty in (
            ("partial", "0.00001"),
            ("residual", "0.00039"),
        ):
            invalid_permit, invalid_plan = validation_lifecycle_fixture(
                datetime.now(timezone.utc),
                permit_id=f"ivp-postgres-lifecycle-forged-{permit_suffix}",
                partial_close_qty=partial_close_qty,
            )
            invalid_client_order_id = infrastructure_validation_client_order_id(
                invalid_permit,
                invalid_plan,
            )
            invalid_intent = build_broker_mutation_intent(
                BrokerMutationIntentRequest(
                    broker_route="alpaca",
                    account_label=invalid_permit.account_label,
                    endpoint_fingerprint=fingerprint_broker_endpoint(
                        str(invalid_permit.broker_base_url)
                    ),
                    operation="submit_order",
                    risk_class="risk_neutral",
                    purpose="control_plane_validation",
                    workflow_id=invalid_client_order_id,
                    client_request_id=invalid_client_order_id,
                    target=BrokerMutationTarget(
                        kind="order",
                        key=invalid_client_order_id,
                    ),
                    request_payload=infrastructure_validation_request_payload(
                        invalid_permit,
                        invalid_plan,
                    ),
                )
            )
            with sessions() as session:
                session.add(_receipt_from_intent(invalid_intent))
                with pytest.raises(IntegrityError) as captured:
                    session.commit()
            assert (
                captured.value.orig.diag.constraint_name
                == "ck_bm_receipt_validation_authority"
            )

        evidence = _seed_validation_lifecycle_root(sessions)
        lineage = infrastructure_validation_lineage_payload(evidence)
        authorization = _submit_close_authorization(
            endpoint_fingerprint=evidence.endpoint_fingerprint,
        )

        missing_fill = _submit_close_intent(
            lineage=lineage,
            endpoint_fingerprint=evidence.endpoint_fingerprint,
            client_request_id="rr-submit-close-missing-fill",
            risk_reduction=authorization.evidence_payload,
        )
        with sessions() as session:
            session.add(_receipt_from_intent(missing_fill))
            with pytest.raises(IntegrityError):
                session.commit()

        event_ts = datetime.now(timezone.utc)
        with sessions() as session:
            session.add(
                _validation_position_event(
                    evidence=evidence,
                    event_ts=event_ts,
                    fingerprint="1" * 64,
                    source_offset=1,
                )
            )
            session.commit()

        stale_risk = copy.deepcopy(dict(authorization.evidence_payload))
        stale_risk["observation"]["observed_at"] = (
            datetime.now(timezone.utc) - timedelta(seconds=10)
        ).isoformat()
        stale = _submit_close_intent(
            lineage=lineage,
            endpoint_fingerprint=evidence.endpoint_fingerprint,
            client_request_id="rr-submit-close-stale-position",
            risk_reduction=stale_risk,
        )
        with sessions() as session:
            session.add(_receipt_from_intent(stale))
            with pytest.raises(IntegrityError):
                session.commit()

        wrong_quantity_risk = copy.deepcopy(dict(authorization.evidence_payload))
        wrong_quantity_risk["observation"]["positions"][0]["signed_quantity"] = (
            "0.00003"
        )
        wrong_quantity = _submit_close_intent(
            lineage=lineage,
            endpoint_fingerprint=evidence.endpoint_fingerprint,
            client_request_id="rr-submit-close-wrong-position",
            risk_reduction=wrong_quantity_risk,
        )
        with sessions() as session:
            session.add(_receipt_from_intent(wrong_quantity))
            with pytest.raises(IntegrityError):
                session.commit()

        valid = _submit_close_intent(
            lineage=lineage,
            endpoint_fingerprint=evidence.endpoint_fingerprint,
            client_request_id="rr-submit-close-valid",
            risk_reduction=authorization.evidence_payload,
        )
        with sessions() as session:
            BrokerMutationCoordinator(
                "validation-submit-close-pg"
            ).execute_unlinked_mutation(
                session,
                intent=valid,
                callbacks=UnlinkedMutationCallbacks(
                    broker_call=lambda _permit: {
                        "id": "validation-resting-close-order-1",
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
            accepted = session.execute(
                select(BrokerMutationReceipt).where(
                    BrokerMutationReceipt.client_request_id == "rr-submit-close-valid"
                )
            ).scalar_one()
        assert (accepted.operation, accepted.risk_class, accepted.purpose) == (
            "submit_order",
            "risk_reducing",
            "closeout",
        )

        forged_event = _validation_position_event(
            evidence=evidence,
            event_ts=event_ts + timedelta(seconds=1),
            fingerprint="2" * 64,
            source_offset=2,
        )
        forged_event.raw_event = copy.deepcopy(forged_event.raw_event)
        forged_event.raw_event["_torghut_evidence_contract"][
            "broker_mutation_receipt_id"
        ] = str(uuid.uuid4())
        with sessions() as session:
            session.add(forged_event)
            session.commit()
        forged = _submit_close_intent(
            lineage=lineage,
            endpoint_fingerprint=evidence.endpoint_fingerprint,
            client_request_id="rr-submit-close-forged-fill-receipt",
            risk_reduction=_submit_close_authorization(
                endpoint_fingerprint=evidence.endpoint_fingerprint,
            ).evidence_payload,
        )
        with sessions() as session:
            session.add(_receipt_from_intent(forged))
            with pytest.raises(IntegrityError):
                session.commit()
    finally:
        drop_schema(schema, admin_engine, schema_engine)


def _seed_validation_root(sessions: sessionmaker[Session]) -> str:
    now = datetime.now(timezone.utc)
    plan = InfrastructureValidationOrderPlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-order-plan.v1",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "1",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "1",
            "stop_price": None,
        }
    )
    permit = InfrastructureValidationPermit.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-permit.v2",
            "permit_id": "ivp-postgres-lineage",
            "purpose": "control_plane_validation",
            "venue": "alpaca",
            "asset_class": "crypto",
            "account_mode": "paper",
            "market_session": "continuous",
            "account_label": "paper",
            "broker_base_url": "https://paper-api.alpaca.markets",
            "symbols": ["BTC/USD"],
            "sides": ["buy"],
            "order_types": ["limit"],
            "max_orders": 1,
            "max_outstanding_intents": 1,
            "max_notional_usd": "1",
            "max_loss_usd": "1",
            "issued_by": "infrastructure-owner",
            "approved_by": "independent-infrastructure-owner",
            "issued_at": now - timedelta(seconds=1),
            "expires_at": now + timedelta(minutes=5),
            "test_plan_digest": infrastructure_validation_order_plan_sha256(plan),
            "expected_terminal_state": "no_open_orders_no_positions_no_unsettled_claims",
            "expected_terminal_state_digest": infrastructure_validation_terminal_state_sha256(),
            "evidence_tag": "non_promotable_validation",
            "promotable": False,
        }
    )
    with sessions() as session:
        BrokerMutationCoordinator(
            "validation-root-pg"
        ).submit_infrastructure_validation_order(
            session,
            request=InfrastructureValidationOrderSubmission(
                permit=permit,
                plan=plan,
                account_label="paper",
                endpoint_url="https://paper-api.alpaca.markets",
            ),
            callbacks=UnlinkedMutationCallbacks(
                broker_call=lambda _permit: {
                    "id": "validation-root-order-1",
                    "status": "accepted",
                },
                persist_terminal=lambda _result: None,
                build_settlement=lambda result: build_broker_mutation_settlement(
                    BrokerMutationSettlementRequest(
                        source="primary",
                        outcome="reconciled",
                        broker_reference=str(result["id"]),
                        execution_id=None,
                        evidence_payload={"status": result["status"]},
                    )
                ),
            ),
            now=now,
        )
    return infrastructure_validation_client_order_id(permit, plan)


def _seed_validation_lifecycle_root(
    sessions: sessionmaker[Session],
) -> object:
    now = datetime.now(timezone.utc)
    permit, plan = validation_lifecycle_fixture(now)
    with sessions() as session:
        BrokerMutationCoordinator(
            "validation-lifecycle-pg"
        ).submit_infrastructure_validation_order(
            session,
            request=InfrastructureValidationOrderSubmission(
                permit=permit,
                plan=plan,
                account_label="paper",
                endpoint_url="https://paper-api.alpaca.markets",
            ),
            callbacks=UnlinkedMutationCallbacks(
                broker_call=lambda _permit: {
                    "id": "validation-lifecycle-root-order-1",
                    "status": "filled",
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
            now=now,
        )
    with sessions() as session:
        evidence = load_infrastructure_validation_evidence(
            session,
            account_label="paper",
            client_order_id=infrastructure_validation_client_order_id(permit, plan),
            alpaca_order_id="validation-lifecycle-root-order-1",
        )
    assert evidence is not None
    return evidence


def _submit_close_authorization(
    *,
    endpoint_fingerprint: str,
) -> RiskReductionAuthorization:
    observed_at = datetime.now(timezone.utc)
    snapshot = BrokerReductionSnapshot(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint=endpoint_fingerprint,
        observed_at=observed_at,
        complete=True,
        positions=(
            BrokerPositionObservation(
                symbol="BTC/USD",
                signed_quantity=Decimal("0.00002"),
                unit_notional=Decimal("100000"),
            ),
        ),
    )
    return authorize_risk_reduction(
        snapshot,
        SubmitCloseOrderPlan(
            leg=PositionCloseLeg(
                symbol="BTC/USD",
                side="sell",
                quantity=Decimal("0.00002"),
            ),
            limit_price=Decimal("200000"),
        ),
        now=observed_at,
    )


def _submit_close_intent(
    *,
    lineage: dict[str, object],
    endpoint_fingerprint: str,
    client_request_id: str,
    risk_reduction: object,
) -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=endpoint_fingerprint,
            operation="submit_order",
            risk_class="risk_reducing",
            purpose="closeout",
            workflow_id=client_request_id,
            client_request_id=client_request_id,
            target=BrokerMutationTarget(kind="order", key="BTC/USD"),
            request_payload={
                "schema_version": "torghut.alpaca-reduction-request.v1",
                "symbol": "BTC/USD",
                "side": "sell",
                "qty": "0.00002",
                "order_type": "limit",
                "time_in_force": "gtc",
                "limit_price": "200000",
                "stop_price": None,
                "extra_params": {"client_order_id": client_request_id},
                "risk_reduction": risk_reduction,
                "infrastructure_validation_lineage": lineage,
            },
        )
    )


def _validation_position_event(
    *,
    evidence: object,
    event_ts: datetime,
    fingerprint: str,
    source_offset: int,
) -> ExecutionOrderEvent:
    return ExecutionOrderEvent(
        event_fingerprint=fingerprint,
        source_topic="torghut.trade-updates.v1",
        source_partition=0,
        source_offset=source_offset,
        alpaca_account_label="paper",
        feed_seq=source_offset,
        event_ts=event_ts,
        symbol="BTC/USD",
        alpaca_order_id="validation-lifecycle-root-order-1",
        client_order_id=evidence.root_client_order_id,
        event_type="fill",
        status="filled",
        qty=Decimal("0.00002"),
        filled_qty=Decimal("0.00002"),
        position_qty=Decimal("0.00002"),
        avg_fill_price=Decimal("100000"),
        raw_event=tag_infrastructure_validation_event(
            {"event": "fill"},
            evidence,
        ),
    )


def _replacement_intent(
    *,
    lineage: dict[str, object],
    endpoint_fingerprint: str,
    client_request_id: str,
    order_id: str,
) -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=endpoint_fingerprint,
            operation="replace_order",
            risk_class="risk_neutral",
            purpose="repricing",
            workflow_id=client_request_id,
            client_request_id=client_request_id,
            target=BrokerMutationTarget(kind="order", key=order_id),
            request_payload={
                "schema_version": "torghut.alpaca-reduction-request.v1",
                "order_id": order_id,
                "limit_price": "0.9",
                "infrastructure_validation_lineage": lineage,
            },
        )
    )


def _cancel_intent(
    *,
    lineage: dict[str, object],
    endpoint_fingerprint: str,
    client_request_id: str,
    order_id: str,
) -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=endpoint_fingerprint,
            operation="cancel_order",
            risk_class="risk_neutral",
            purpose="operator",
            workflow_id=client_request_id,
            client_request_id=client_request_id,
            target=BrokerMutationTarget(kind="order", key=order_id),
            request_payload={
                "schema_version": "torghut.alpaca-reduction-request.v1",
                "order_id": order_id,
                "infrastructure_validation_lineage": lineage,
            },
        )
    )


def _close_intent(
    *,
    lineage: dict[str, object],
    endpoint_fingerprint: str,
) -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=endpoint_fingerprint,
            operation="close_position",
            risk_class="risk_reducing",
            purpose="closeout",
            workflow_id="validation-close-forged",
            client_request_id="validation-close-forged",
            target=BrokerMutationTarget(kind="position", key="BTC/USD"),
            request_payload={
                "schema_version": "torghut.alpaca-reduction-request.v1",
                "symbol": "BTC/USD",
                "quantity": "1",
                "infrastructure_validation_lineage": lineage,
            },
        )
    )


def _receipt_from_intent(intent: BrokerMutationIntent) -> BrokerMutationReceipt:
    return BrokerMutationReceipt(
        broker_route=intent.broker_route,
        account_label=intent.account_label,
        endpoint_fingerprint=intent.endpoint_fingerprint,
        operation=intent.operation,
        risk_class=intent.risk_class,
        purpose=intent.purpose,
        submission_claim_id=intent.submission_claim_id,
        workflow_id=intent.workflow_id,
        client_request_id=intent.client_request_id,
        target_kind=intent.target.kind,
        target_key=intent.target.key,
        intent_schema_version=intent.intent_schema_version,
        canonical_intent_json=intent.canonical_intent_json,
        canonical_intent_sha256=intent.canonical_intent_sha256,
        creator_owner="validation-lineage-forgery-test",
        origin_writer_generation=1,
    )
