from __future__ import annotations

import copy
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, ExecutionOrderEvent
from app.trading.broker_mutation_coordinator import (
    BrokerMutationCoordinator,
    InfrastructureValidationOrderSubmission,
    UnlinkedMutationCallbacks,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationSettlementRequest,
    build_broker_mutation_settlement,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationLifecyclePlan,
    InfrastructureValidationPermit,
    infrastructure_validation_client_order_id,
    infrastructure_validation_lifecycle_plan_sha256,
    infrastructure_validation_terminal_state_sha256,
)
from app.trading.infrastructure_validation_records import (
    InfrastructureValidationEvidence,
    load_infrastructure_validation_evidence,
    require_infrastructure_validation_flat_position_evidence,
    require_infrastructure_validation_position_evidence,
    tag_infrastructure_validation_event,
)


@pytest.fixture
def session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as value:
        yield value
    engine.dispose()


def test_position_evidence_requires_exact_tagged_fill_and_quantity(
    session: Session,
) -> None:
    evidence = _seed_lifecycle_root(session)
    event = _position_event(
        evidence,
        fingerprint="a" * 64,
        position_quantity=Decimal("0.00040000"),
    )
    session.add(event)
    session.commit()

    proven = require_infrastructure_validation_position_evidence(
        session,
        evidence=evidence,
        symbol="btc/usd",
        signed_quantity=Decimal("0.0004"),
    )

    assert proven.order_event_id == event.id
    assert proven.alpaca_order_id == "validation-root-order-1"
    assert proven.symbol == "BTC/USD"
    assert proven.filled_quantity == Decimal("0.00040000")
    assert proven.position_quantity == Decimal("0.00040000")
    assert proven.average_fill_price == Decimal("70000.00000000")
    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_position_not_reconciled",
    ):
        require_infrastructure_validation_position_evidence(
            session,
            evidence=evidence,
            symbol="BTC/USD",
            signed_quantity=Decimal("0.0003"),
        )


def test_position_evidence_rejects_forged_receipt_and_linked_event(
    session: Session,
) -> None:
    evidence = _seed_lifecycle_root(session)
    forged = _position_event(
        evidence,
        fingerprint="b" * 64,
        position_quantity=Decimal("0.0004"),
    )
    forged.raw_event = copy.deepcopy(forged.raw_event)
    forged.raw_event["_torghut_evidence_contract"]["broker_mutation_receipt_id"] = str(
        uuid.uuid4()
    )
    linked = _position_event(
        evidence,
        fingerprint="c" * 64,
        position_quantity=Decimal("0.0004"),
    )
    linked.trade_decision_id = uuid.uuid4()
    session.add_all((forged, linked))
    session.commit()

    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_position_fill_missing",
    ):
        require_infrastructure_validation_position_evidence(
            session,
            evidence=evidence,
            symbol="BTC/USD",
            signed_quantity=Decimal("0.0004"),
        )


def test_position_evidence_rejects_nonpositive_broker_position(
    session: Session,
) -> None:
    evidence = _seed_lifecycle_root(session)
    session.add(
        _position_event(
            evidence,
            fingerprint="d" * 64,
            position_quantity=Decimal("0"),
        )
    )
    session.commit()

    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_position_quantity_invalid",
    ):
        require_infrastructure_validation_position_evidence(
            session,
            evidence=evidence,
            symbol="BTC/USD",
            signed_quantity=Decimal("0.0004"),
        )

    flat = require_infrastructure_validation_flat_position_evidence(
        session,
        evidence=evidence,
        symbol="BTC/USD",
    )
    assert flat.position_quantity == 0


def _seed_lifecycle_root(session: Session) -> InfrastructureValidationEvidence:
    now = datetime.now(timezone.utc)
    plan = InfrastructureValidationLifecyclePlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-lifecycle-plan.v2",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "0.0004",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "70000",
            "stop_price": None,
            "resting_close_limit_price": "130000",
            "replacement_close_limit_price": "140000",
            "partial_close_qty": "0.0002",
        }
    )
    permit = InfrastructureValidationPermit.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-permit.v2",
            "permit_id": "ivp-position-evidence-test",
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
            "max_notional_usd": "30",
            "max_loss_usd": "30",
            "issued_by": "infrastructure-owner",
            "approved_by": "independent-infrastructure-owner",
            "issued_at": now - timedelta(seconds=1),
            "expires_at": now + timedelta(minutes=5),
            "test_plan_digest": infrastructure_validation_lifecycle_plan_sha256(plan),
            "expected_terminal_state": (
                "no_open_orders_no_positions_no_unsettled_claims"
            ),
            "expected_terminal_state_digest": (
                infrastructure_validation_terminal_state_sha256()
            ),
            "evidence_tag": "non_promotable_validation",
            "promotable": False,
        }
    )
    BrokerMutationCoordinator(
        "validation-position-proof"
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
    evidence = load_infrastructure_validation_evidence(
        session,
        account_label="paper",
        client_order_id=infrastructure_validation_client_order_id(permit, plan),
        alpaca_order_id="validation-root-order-1",
    )
    assert evidence is not None
    return evidence


def _position_event(
    evidence: InfrastructureValidationEvidence,
    *,
    fingerprint: str,
    position_quantity: Decimal,
) -> ExecutionOrderEvent:
    return ExecutionOrderEvent(
        event_fingerprint=fingerprint,
        source_topic="torghut.trade-updates.v1",
        source_partition=0,
        source_offset=int(fingerprint[0], 16),
        alpaca_account_label="paper",
        feed_seq=int(fingerprint[0], 16),
        event_ts=datetime.now(timezone.utc),
        symbol="BTC/USD",
        alpaca_order_id="validation-root-order-1",
        client_order_id=evidence.root_client_order_id,
        event_type="fill",
        status="filled",
        qty=Decimal("0.0004"),
        filled_qty=Decimal("0.0004"),
        position_qty=position_quantity,
        avg_fill_price=Decimal("70000"),
        raw_event=tag_infrastructure_validation_event(
            {"event": "fill"},
            evidence,
        ),
    )
